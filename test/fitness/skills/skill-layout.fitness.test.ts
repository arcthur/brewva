import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSkillDocument } from "@brewva/brewva-vocabulary/session";
import type { SkillCategory } from "@brewva/brewva-vocabulary/session";

const LOADABLE_CATEGORIES = ["core", "domain", "operator", "meta", "internal"] as const;

function listMissingSkillDocuments(root: string): string[] {
  const missing: string[] = [];

  for (const category of LOADABLE_CATEGORIES) {
    const categoryDir = join(root, category);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(categoryDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(categoryDir, entry.name);
      const skillPath = join(skillDir, "SKILL.md");
      try {
        if (!statSync(skillPath).isFile()) {
          missing.push(`${category}/${entry.name}`);
        }
      } catch {
        missing.push(`${category}/${entry.name}`);
      }
    }
  }

  return missing.toSorted();
}

function collectSkillFiles(root: string): string[] {
  const files: string[] = [];

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
      const skillPath = join(categoryDir, entry.name, "SKILL.md");
      try {
        if (statSync(skillPath).isFile()) {
          files.push(skillPath);
        }
      } catch {
        // Ignore non-skill folders.
      }
    }
  }

  return files.toSorted();
}

function inferCategory(skillFile: string): SkillCategory {
  if (skillFile.includes("/skills/core/")) return "core";
  if (skillFile.includes("/skills/domain/")) return "domain";
  if (skillFile.includes("/skills/operator/")) return "operator";
  if (skillFile.includes("/skills/meta/")) return "meta";
  if (skillFile.includes("/skills/internal/")) return "internal";
  if (skillFile.includes("/skills/project/overlays/")) return "overlay";
  throw new Error(`Unsupported skill path: ${skillFile}`);
}

function sectionBodyLines(content: string, heading: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).filter((line) => line.trim().length > 0);
}

function normalizeRoutingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

describe("skill layout quality", () => {
  it("keeps every loadable skill directory anchored by SKILL.md", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const missing = listMissingSkillDocuments(resolve(repoRoot, "skills"));
    expect(missing, `Directories missing SKILL.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps authority fields out of SkillCard frontmatter", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const skillFiles = collectSkillFiles(resolve(repoRoot, "skills"));
    const removedFields = [
      "routing",
      "intent",
      "effects",
      "resources",
      "execution_hints",
      "consumes",
      "requires",
      "composable_with",
      "stability",
      "budget",
      "tools",
      "dispatch",
    ];

    for (const skillFile of skillFiles) {
      const content = readFileSync(skillFile, "utf8");
      for (const field of removedFields) {
        expect(content, `${skillFile} should not declare removed field '${field}'`).not.toMatch(
          new RegExp(`^${field}:`, "m"),
        );
      }
    }
  });

  it("omits empty requires arrays from authored skill frontmatter", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const skillFiles = collectSkillFiles(resolve(repoRoot, "skills"));

    for (const skillFile of skillFiles) {
      const content = readFileSync(skillFile, "utf8");
      expect(content, `${skillFile} should omit empty requires`).not.toMatch(
        /^requires:\s*\[\]\s*$/m,
      );
    }
  });

  it("keeps catalog descriptions distinct from when-to-use routing text", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const skillFiles = collectSkillFiles(resolve(repoRoot, "skills"));

    for (const skillFile of skillFiles) {
      const parsed = parseSkillDocument(skillFile, inferCategory(skillFile));
      const whenToUse = parsed.card.selection?.whenToUse;
      if (!whenToUse) continue;

      expect(
        parsed.description,
        `${skillFile} description should summarize catalog identity, not start with routing phrasing`,
      ).not.toMatch(/^Use when\b/i);
      expect(
        normalizeRoutingText(parsed.description),
        `${skillFile} description should not duplicate selection.when_to_use`,
      ).not.toBe(normalizeRoutingText(whenToUse));
    }
  });

  it("keeps heavyweight examples and rationalization tables in references", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const skillFiles = collectSkillFiles(resolve(repoRoot, "skills")).filter(
      (skillFile) => !skillFile.includes("/skills/project/overlays/"),
    );

    for (const skillFile of skillFiles) {
      const content = readFileSync(skillFile, "utf8");
      const concreteExample = sectionBodyLines(content, "## Concrete Example");
      if (concreteExample.length > 0) {
        expect(concreteExample, `${skillFile} should link to extracted example`).toEqual([
          "See `references/example.md` for the grounded example output shape.",
        ]);
      }

      const rationalizations = sectionBodyLines(content, "## Common Rationalizations");
      if (rationalizations.length > 0) {
        expect(
          [
            ["See `references/rationalizations.md` for the anti-pattern table."],
            [
              "See `references/rationalizations.md` for the provenance-bearing anti-pattern",
              "inventory; do not duplicate it in the kernel.",
            ],
          ],
          `${skillFile} should use one of the exact extracted-rationalization links`,
        ).toContainEqual(rationalizations);
      }
    }
  });

  it("keeps shared authored behavior as runtime-inherited guidance", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const skillFiles = collectSkillFiles(resolve(repoRoot, "skills"));
    const allowedSource = resolve(
      repoRoot,
      "skills/meta/skill-authoring/references/authored-behavior.md",
    );

    for (const skillFile of skillFiles) {
      const content = readFileSync(skillFile, "utf8");
      if (skillFile.endsWith("/skills/meta/skill-authoring/SKILL.md")) {
        continue;
      }
      expect(
        content,
        `${skillFile} should not explicitly reference authored-behavior`,
      ).not.toContain("authored-behavior.md");
    }

    // The cross-skill deviation rule lives ONLY in authored-behavior.md: skills
    // inherit it at runtime instead of restating it. The sentinel phrase is the
    // v3 deviation-with-evidence rule (which replaced the retired
    // letter-compliance clause). Whitespace is normalized so the formatter's
    // line wrapping cannot hide a match.
    const sentinel = "An exception needs evidence, not eloquence";
    const flatten = (value: string): string => value.replace(/\s+/g, " ");
    const occurrences = collectSkillFiles(resolve(repoRoot, "skills")).flatMap((skillFile) => {
      const content = flatten(readFileSync(skillFile, "utf8"));
      return content.includes(sentinel) ? [skillFile] : [];
    });
    const referenceContent = flatten(readFileSync(allowedSource, "utf8"));

    expect(occurrences).toEqual([]);
    expect(referenceContent).toContain(sentinel);
    expect(referenceContent).not.toContain("Violating the letter");
  });

  it("keeps coding discipline guardrails in prep and implementation skills", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const prep = readFileSync(resolve(repoRoot, "skills/core/prep/SKILL.md"), "utf8");
    const simplicity = readFileSync(
      resolve(repoRoot, "skills/core/prep/invariants/simplicity-check.md"),
      "utf8",
    );
    const implementation = readFileSync(
      resolve(repoRoot, "skills/core/implementation/SKILL.md"),
      "utf8",
    );

    expect(prep).toContain("Do not choose silently");
    expect(prep).toContain("runnable command or observable check before editing");
    expect(simplicity).toContain("unrequested configurability");
    expect(simplicity).toContain("impossible scenario");
    expect(implementation).toMatch(
      /Every\s+changed\s+file\s+must\s+trace\s+to\s+`implementation_targets`/,
    );
    expect(implementation).toContain("pre-existing dead code");
  });
});
