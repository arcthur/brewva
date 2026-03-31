import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function collectToolNames(sourceRoot: string): string[] {
  const files = [
    "ast-grep.ts",
    "browser.ts",
    "cost-view.ts",
    "deliberation-memory.ts",
    "exec.ts",
    "grep.ts",
    "iteration-fact.ts",
    "knowledge-capture.ts",
    "knowledge-search.ts",
    "ledger-query.ts",
    "look-at.ts",
    "lsp.ts",
    "read-spans.ts",
    "observability/obs-query.ts",
    "observability/obs-slo-assert.ts",
    "observability/obs-snapshot.ts",
    "optimization-continuity.ts",
    "output-search.ts",
    "precedent-audit.ts",
    "precedent-sweep.ts",
    "process.ts",
    "rollback-last-patch.ts",
    "schedule-intent.ts",
    "session-compact.ts",
    "skill-load.ts",
    "skill-complete.ts",
    "skill-promotion.ts",
    "subagent-control.ts",
    "subagent-run.ts",
    "tape.ts",
    "task-ledger.ts",
    "toc.ts",
    "worker-results.ts",
  ];

  const names = new Set<string>();
  for (const file of files) {
    const text = readFileSync(join(sourceRoot, file), "utf-8");
    const matches = text.match(/name:\s*"([a-z0-9_]+)"/g) ?? [];
    for (const match of matches) {
      const parsed = /name:\s*"([a-z0-9_]+)"/.exec(match)?.[1];
      if (parsed) names.add(parsed);
    }
  }

  return [...names].toSorted();
}

describe("docs/guide features tool coverage", () => {
  it("documents all tool names in features guide", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const toolNames = collectToolNames(resolve(repoRoot, "packages/brewva-tools/src"));
    const markdown = readFileSync(resolve(repoRoot, "docs/guide/features.md"), "utf-8");

    const missing = toolNames.filter((name) => !markdown.includes(`\`${name}\``));

    expect(missing, `Missing tools in docs/guide/features.md: ${missing.join(", ")}`).toEqual([]);
  });
});
