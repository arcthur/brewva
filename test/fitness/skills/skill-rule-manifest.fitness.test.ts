import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

// The v3 rule manifest (skills/meta/skill-authoring/references/skill-anatomy-v3.md)
// gives every load-bearing skill rule a stable identity, a tier, and — for
// controlled exceptions — the evidence class an exception must cite. Receipts,
// calibration, and any future strictness profile bind to the ruleId, so the
// grammar is a contract: this fitness keeps it parseable and keeps the pilot
// skills carrying it. quick_validate.py enforces the same grammar on the
// authoring side; this is the repo-gate side.

// Pilot skills whose Rules manifest is load-bearing (receipts may cite these
// ids). Removing a manifest here is a contract break, not a doc edit.
const REQUIRED_MANIFEST_SKILLS = ["core/debugging", "core/review", "core/learning-research"];

const repoRoot = resolve(import.meta.dirname, "../../..");
const ruleSchema = JSON.parse(
  readFileSync(
    join(repoRoot, "skills/meta/skill-authoring/references/rule-manifest-schema.json"),
    "utf8",
  ),
) as {
  tiers: string[];
  ruleIdPattern: string;
  ruleBulletPattern: string;
  exceptionEvidenceMarker: string;
};
const RULE_TIERS = new Set(ruleSchema.tiers);
const RULE_ID_PATTERN = new RegExp(ruleSchema.ruleIdPattern, "u");
const RULE_BULLET_PATTERN = new RegExp(ruleSchema.ruleBulletPattern, "u");

interface SkillRuleEntry {
  readonly ruleId: string;
  readonly tier: string;
  readonly statement: string;
}

interface SkillRulesManifest {
  readonly skillRef: string;
  readonly manifestRef: string;
  readonly skillName: string;
  readonly rules: readonly SkillRuleEntry[];
}

function collectSkillFiles(root: string): Array<{ skillRef: string; filePath: string }> {
  const files: Array<{ skillRef: string; filePath: string }> = [];
  const visit = (directory: string): void => {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push({
          skillRef: relative(root, dirname(filePath)).split("\\").join("/"),
          filePath,
        });
      }
    }
  };
  visit(root);
  return files.toSorted((left, right) => left.skillRef.localeCompare(right.skillRef));
}

function extractRulesSection(content: string): string | null {
  const lines = content.split("\n");
  const headings = lines
    .map((line, index) => ({ index, heading: line.trim() }))
    .filter((entry) => entry.heading === "## Rules");
  if (headings.length > 1) {
    throw new Error("Rules section must appear at most once");
  }
  const start = headings[0]?.index ?? -1;
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function parseRuleBullets(section: string): { bullets: string[]; strayLines: string[] } {
  const bullets: string[] = [];
  const strayLines: string[] = [];
  let current: string[] = [];
  for (const line of section.split("\n")) {
    if (line.startsWith("- `")) {
      if (current.length > 0) bullets.push(current.join(" "));
      current = [line.trim()];
    } else if (!line.trim()) {
      continue;
    } else if (line.startsWith("  ") && current.length > 0) {
      current.push(line.trim());
    } else {
      strayLines.push(line.trim());
    }
  }
  if (current.length > 0) bullets.push(current.join(" "));
  return { bullets, strayLines };
}

function parseManifest(
  skillRef: string,
  manifestRef: string,
  filePath: string,
  inheritedSkillName?: string,
): SkillRulesManifest | null {
  const content = readFileSync(filePath, "utf8");
  const section = extractRulesSection(content);
  if (section === null) return null;
  const nameMatch = content.match(/^name:\s*(\S+)\s*$/mu);
  const skillName = nameMatch?.[1] ?? inheritedSkillName ?? skillRef.split("/").at(-1) ?? skillRef;
  const { bullets, strayLines } = parseRuleBullets(section);
  expect(strayLines, `${skillRef}: Rules section contains non-rule lines`).toEqual([]);
  expect(bullets.length, `${skillRef}: Rules section is present but empty`).toBeGreaterThan(0);
  const rules = bullets.map((bullet) => {
    const match = RULE_BULLET_PATTERN.exec(bullet);
    expect(
      match,
      `${skillRef}: rule bullet must match '- \`<ruleId>\` (<tier>) — <statement>': ${bullet.slice(0, 100)}`,
    ).not.toBeNull();
    const [, ruleId, tier, statement] = match as RegExpExecArray;
    return { ruleId: ruleId ?? "", tier: tier ?? "", statement: statement ?? "" };
  });
  return { skillRef, manifestRef, skillName, rules };
}

describe("skill rule manifests", () => {
  const skillFiles = collectSkillFiles(resolve(repoRoot, "skills"));
  const manifests = skillFiles.flatMap((file): SkillRulesManifest[] => {
    const skillName =
      readFileSync(file.filePath, "utf8").match(/^name:\s*(\S+)\s*$/mu)?.[1] ??
      file.skillRef.split("/").at(-1) ??
      file.skillRef;
    const candidates = [{ manifestRef: file.skillRef, filePath: file.filePath }];
    const strictPath = join(file.filePath, "..", "references", "strict-protocol.md");
    try {
      if (statSync(strictPath).isFile()) {
        candidates.push({
          manifestRef: `${file.skillRef}/references/strict-protocol.md`,
          filePath: strictPath,
        });
      }
    } catch {
      // No strict scaffold for this skill.
    }
    return candidates
      .map((candidate) =>
        parseManifest(file.skillRef, candidate.manifestRef, candidate.filePath, skillName),
      )
      .filter((manifest): manifest is SkillRulesManifest => manifest !== null);
  });

  it("recursively covers every SkillCard path that the production catalog can load", () => {
    const root = mkdtempSync(join(tmpdir(), "rule-manifest-recursive-"));
    try {
      const nested = join(root, "domain/parent/nested");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "SKILL.md"), "---\nname: nested\n---\n", "utf8");
      expect(collectSkillFiles(root).map((file) => file.skillRef)).toEqual([
        "domain/parent/nested",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the pilot skills carrying a Rules manifest", () => {
    const covered = new Set(manifests.map((manifest) => manifest.skillRef));
    for (const required of REQUIRED_MANIFEST_SKILLS) {
      expect(covered.has(required), `${required} must carry a Rules manifest`).toBe(true);
    }
  });

  it("keeps every pilot strict scaffold load-bearing item inside a Rules manifest", () => {
    for (const required of REQUIRED_MANIFEST_SKILLS) {
      const manifestRef = `${required}/references/strict-protocol.md`;
      expect(
        manifests.some((manifest) => manifest.manifestRef === manifestRef),
        `${manifestRef} must carry a Rules manifest`,
      ).toBe(true);
      const content = readFileSync(join(repoRoot, "skills", manifestRef), "utf8");
      expect(content).not.toContain("## Hard caps");
      expect(content).not.toContain("## Red flags");
    }
  });

  it("keeps pilot rationalization inventories rule-bound and honestly provenance-limited", () => {
    const knownRuleIds = new Set(
      manifests.flatMap((manifest) => manifest.rules.map((rule) => rule.ruleId)),
    );
    for (const required of REQUIRED_MANIFEST_SKILLS) {
      const filePath = join(repoRoot, "skills", required, "references", "rationalizations.md");
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("| Canonical rule");
      expect(content).toContain("| Provenance");
      expect(content).toContain("| Lifecycle");
      const rows = content
        .split("\n")
        .filter((line) => line.startsWith("|") && !line.includes("| ---"))
        .slice(1);
      expect(
        rows.length,
        `${required}: rationalization inventory must not be empty`,
      ).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatch(/`[a-z0-9.-]+`/u);
        const ruleId = row.match(/`([a-z0-9.-]+)`/u)?.[1];
        expect(
          knownRuleIds.has(ruleId ?? ""),
          `${required}: rationalization row cites unknown rule '${ruleId}'`,
        ).toBe(true);
        expect(row).toContain("legacy-unattributed (model/date unavailable)");
        expect(row).toContain("retirement-review-required");
      }
    }
  });

  it("keeps every rule id well-formed, skill-prefixed, and tiered", () => {
    for (const manifest of manifests) {
      for (const rule of manifest.rules) {
        expect(
          RULE_ID_PATTERN.test(rule.ruleId),
          `${manifest.skillRef}: rule id '${rule.ruleId}' must be '<skill>.<rule-slug>' kebab segments`,
        ).toBe(true);
        expect(
          rule.ruleId.startsWith(`${manifest.skillName}.`),
          `${manifest.skillRef}: rule id '${rule.ruleId}' must be prefixed with the skill name '${manifest.skillName}.' so receipts attribute cleanly`,
        ).toBe(true);
        expect(
          RULE_TIERS.has(rule.tier),
          `${manifest.skillRef}: rule '${rule.ruleId}' has unknown tier '${rule.tier}'`,
        ).toBe(true);
      }
    }
  });

  it("requires an exception-evidence clause on every controlled-exception rule", () => {
    for (const manifest of manifests) {
      for (const rule of manifest.rules) {
        if (rule.tier !== "controlled-exception") continue;
        const marker = ruleSchema.exceptionEvidenceMarker;
        const evidence = rule.statement.split(marker, 2)[1]?.trim() ?? "";
        expect(
          evidence.length > 0,
          `${manifest.skillRef}: controlled-exception rule '${rule.ruleId}' must name its 'Exception evidence:' class`,
        ).toBe(true);
      }
    }
  });

  it("keeps rule ids globally unique so receipts attribute to one rule", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const manifest of manifests) {
      for (const rule of manifest.rules) {
        const previous = seen.get(rule.ruleId);
        if (previous !== undefined) {
          duplicates.push(
            `'${rule.ruleId}' declared by both ${previous} and ${manifest.manifestRef}`,
          );
        }
        seen.set(rule.ruleId, manifest.manifestRef);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
