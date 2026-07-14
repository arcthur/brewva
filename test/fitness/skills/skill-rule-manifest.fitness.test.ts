import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// The v3 rule manifest (skills/meta/skill-authoring/references/skill-anatomy-v3.md)
// gives every load-bearing skill rule a stable identity, a tier, and — for
// controlled exceptions — the evidence class an exception must cite. Receipts,
// calibration, and any future strictness profile bind to the ruleId, so the
// grammar is a contract: this fitness keeps it parseable and keeps the pilot
// skills carrying it. quick_validate.py enforces the same grammar on the
// authoring side; this is the repo-gate side.

const LOADABLE_CATEGORIES = ["core", "domain", "operator", "meta", "internal"] as const;

// Pilot skills whose Rules manifest is load-bearing (receipts may cite these
// ids). Removing a manifest here is a contract break, not a doc edit.
const REQUIRED_MANIFEST_SKILLS = ["core/debugging", "core/review", "core/learning-research"];

const RULE_TIERS = new Set(["non-negotiable", "controlled-exception", "adaptive-heuristic"]);
const RULE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const RULE_BULLET_PATTERN = /^- `([^`]+)` \(([a-z-]+)\) — (.+)$/u;

interface SkillRuleEntry {
  readonly ruleId: string;
  readonly tier: string;
  readonly statement: string;
}

interface SkillRulesManifest {
  readonly skillRef: string;
  readonly skillName: string;
  readonly rules: readonly SkillRuleEntry[];
}

function collectSkillFiles(root: string): Array<{ skillRef: string; filePath: string }> {
  const files: Array<{ skillRef: string; filePath: string }> = [];
  for (const category of [...LOADABLE_CATEGORIES, "project/overlays"] as const) {
    const categoryDir = join(root, category);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(categoryDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = join(categoryDir, entry.name, "SKILL.md");
      try {
        if (statSync(filePath).isFile()) {
          files.push({ skillRef: `${category}/${entry.name}`, filePath });
        }
      } catch {
        // Not a skill directory.
      }
    }
  }
  return files.toSorted((left, right) => left.skillRef.localeCompare(right.skillRef));
}

function extractRulesSection(content: string): string | null {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Rules");
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

function parseManifest(skillRef: string, filePath: string): SkillRulesManifest | null {
  const content = readFileSync(filePath, "utf8");
  const section = extractRulesSection(content);
  if (section === null) return null;
  const nameMatch = content.match(/^name:\s*(\S+)\s*$/mu);
  const skillName = nameMatch?.[1] ?? skillRef.split("/").at(-1) ?? skillRef;
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
  return { skillRef, skillName, rules };
}

describe("skill rule manifests", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const skillFiles = collectSkillFiles(resolve(repoRoot, "skills"));
  const manifests = skillFiles
    .map((file) => parseManifest(file.skillRef, file.filePath))
    .filter((manifest): manifest is SkillRulesManifest => manifest !== null);

  it("keeps the pilot skills carrying a Rules manifest", () => {
    const covered = new Set(manifests.map((manifest) => manifest.skillRef));
    for (const required of REQUIRED_MANIFEST_SKILLS) {
      expect(covered.has(required), `${required} must carry a Rules manifest`).toBe(true);
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
        expect(
          rule.statement.includes("Exception evidence:"),
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
          duplicates.push(`'${rule.ruleId}' declared by both ${previous} and ${manifest.skillRef}`);
        }
        seen.set(rule.ruleId, manifest.skillRef);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
