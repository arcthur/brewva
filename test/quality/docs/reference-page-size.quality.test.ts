import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function listMarkdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function removeGeneratedSegments(markdown: string): string {
  return markdown.replace(
    /<!-- generated:[a-z0-9-]+ start -->[\s\S]*?<!-- generated:[a-z0-9-]+ end -->/g,
    "",
  );
}

describe("reference page size", () => {
  it("keeps reference pages under the manual-reading budget", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const referenceRoot = resolve(repoRoot, "docs/reference");
    const allowedLargePages = new Set([
      "docs/reference/context-composer.md",
      "docs/reference/runtime-plugins.md",
      "docs/reference/session-lifecycle.md",
      "docs/reference/token-cache.md",
    ]);

    const oversized = listMarkdownFiles(referenceRoot)
      .filter(
        (path) => removeGeneratedSegments(readFileSync(path, "utf-8")).split("\n").length > 300,
      )
      .map((path) => path.replace(`${repoRoot}/`, ""))
      .filter((path) => !allowedLargePages.has(path));

    expect(oversized, `Reference pages exceed 300 manual lines: ${oversized.join(", ")}`).toEqual(
      [],
    );
  });
});
