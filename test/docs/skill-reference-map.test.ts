import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSkillDocument, type SkillCategory } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return resolve(import.meta.dirname, "../..");
}

function collectSkillFiles(root: string, relativeDirs: string[]): string[] {
  const files: string[] = [];
  for (const relativeDir of relativeDirs) {
    const absoluteDir = join(root, relativeDir);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(absoluteDir, entry.name, "SKILL.md");
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
  if (skillFile.includes("/skills/project/overlays/")) return "overlay";
  throw new Error(`Unsupported skill path: ${skillFile}`);
}

describe("skill resource maps", () => {
  const root = repoRoot();
  const skillFiles = collectSkillFiles(root, [
    "skills/core",
    "skills/domain",
    "skills/operator",
    "skills/meta",
    "skills/project/overlays",
  ]);

  for (const skillFile of skillFiles) {
    test(`${skillFile} references existing resource files`, () => {
      const parsed = parseSkillDocument(skillFile, inferCategory(skillFile));
      const declaredResources = [
        ...parsed.resources.references,
        ...parsed.resources.scripts,
        ...parsed.resources.heuristics,
        ...parsed.resources.invariants,
      ];

      for (const resourcePath of declaredResources) {
        const skillRelativePath = resolve(parsed.baseDir, resourcePath);
        const repoRelativePath = resolve(root, resourcePath);
        expect(existsSync(skillRelativePath) || existsSync(repoRelativePath)).toBe(true);
      }
    });
  }
});
