import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE_PATTERNS: Array<{ relativePath: string; banned: RegExp[] }> = [
  {
    relativePath: "docs/reference/skills.md",
    banned: [/\bdispatch\.suggest_threshold\/auto_threshold\b/u, /and `dispatch`\./u],
  },
  {
    relativePath: "docs/guide/category-and-skills.md",
    banned: [/\bdispatch\/routing constraints\b/u],
  },
  {
    relativePath: "docs/reference/configuration.md",
    banned: [/\bdispatch thresholds\b/u],
  },
];

describe("docs removed skill-contract terms", () => {
  it("does not describe removed dispatch-based skill contract fields", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const violations: string[] = [];

    for (const entry of FILE_PATTERNS) {
      const filePath = resolve(repoRoot, entry.relativePath);
      const content = readFileSync(filePath, "utf-8");
      for (const pattern of entry.banned) {
        if (!pattern.test(content)) continue;
        violations.push(`${entry.relativePath}: matched ${pattern.toString()}`);
      }
    }

    expect(
      violations,
      `Found removed skill-contract terms in docs:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
