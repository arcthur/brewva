import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE_PATTERNS: Array<{ relativePath: string; banned: RegExp[] }> = [
  {
    relativePath: "docs/reference/extensions.md",
    banned: [/\bPi API providers\b/u, /\bbefore Pi emits the final hosted completion\b/u],
  },
  {
    relativePath: "docs/architecture/control-and-data-flow.md",
    banned: [/\bPi session\b/u],
  },
  {
    relativePath: "docs/reference/commands.md",
    banned: [/\bchannel gateway orchestration\b/u],
  },
  {
    relativePath: "docs/guide/installation.md",
    banned: [/@mariozechner\/pi-coding-agent/u],
  },
];

describe("docs hosted terminology guard", () => {
  it("does not describe hosted runtime-plugin surfaces with legacy Pi/gateway wording", () => {
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
      `Found legacy hosted terminology in docs:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
