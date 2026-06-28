import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// DuckDB was the session-index engine before SQLite + FTS5 (see
// docs/research/decisions/session-index-read-model-engine.md). It may remain as
// historical provenance under docs/research/** (immutable decisions, archive,
// and active exploration) and as "DuckDB-era" history comments in code, but it
// must not appear as current fact in live rules, skills, operator scripts,
// journeys, guides, reference, architecture, or troubleshooting docs.
const DUCKDB_PATTERN = /duckdb/iu;
const SCAN_EXTENSIONS = [".md", ".sh"] as const;

function listScannableFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listScannableFiles(fullPath));
      continue;
    }
    if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("legacy duckdb term guard", () => {
  it("live rules, skills, and reference docs present SQLite, not DuckDB", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    // Live authoritative surfaces only. docs/research/** is intentionally
    // excluded: it carries DuckDB as immutable provenance and exploration.
    const roots = [
      "AGENTS.md",
      "skills",
      "docs/guide",
      "docs/journeys",
      "docs/reference",
      "docs/architecture",
      "docs/troubleshooting",
      "docs/solutions",
    ].map((path) => resolve(repoRoot, path));

    const violations: string[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const files = statSync(root).isDirectory() ? listScannableFiles(root) : [root];
      for (const filePath of files) {
        if (DUCKDB_PATTERN.test(readFileSync(filePath, "utf-8"))) {
          violations.push(
            `${relative(repoRoot, filePath)}: references DuckDB; the session index is SQLite + FTS5`,
          );
        }
      }
    }

    expect(
      violations,
      `Found legacy DuckDB references in live surfaces:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
