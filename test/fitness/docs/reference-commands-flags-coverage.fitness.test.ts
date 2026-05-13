import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectInlineCodeValues, extractGeneratedSegment } from "./generated-segments.shared.js";

function extractLongFlags(cliSource: string): string[] {
  const matches = cliSource.match(/--[a-z][a-z-]*/g) ?? [];
  return [...new Set(matches)].toSorted();
}

describe("docs/reference commands coverage", () => {
  it("generates all long-form CLI flags", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const cliPath = resolve(repoRoot, "packages/brewva-cli/src/index.ts");
    const docsPath = resolve(repoRoot, "docs/reference/commands.md");

    const cliSource = readFileSync(cliPath, "utf-8");
    const docs = readFileSync(docsPath, "utf-8");
    const segment = extractGeneratedSegment(docs, "cli-flags");
    const documented = collectInlineCodeValues(segment);

    const flags = extractLongFlags(cliSource);
    const missing = flags.filter((flag) => !documented.has(flag));

    expect(
      missing,
      `Missing CLI flags in generated command inventory: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
