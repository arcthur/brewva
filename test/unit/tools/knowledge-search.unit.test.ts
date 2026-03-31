import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createKnowledgeSearchTool } from "@brewva/brewva-tools";
import { createTestWorkspace } from "../../helpers/workspace.js";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function writeKnowledgeDoc(workspace: string, relativePath: string, content: string): void {
  const absolutePath = join(workspace, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

describe("knowledge search tool", () => {
  test("returns source-typed repository precedents with relevance and authority details", async () => {
    const workspace = createTestWorkspace("knowledge-search");
    writeKnowledgeDoc(
      workspace,
      "docs/solutions/runtime-errors/wal-recovery-race.md",
      `---
title: WAL recovery race during replay
status: active
problem_kind: bugfix
module: brewva-runtime
boundaries:
  - runtime.turnWal
  - runtime.tools
tags:
  - wal
  - recovery
updated_at: 2026-03-31
---

# WAL recovery race during replay

The replay path produced duplicate effect authorization when recovery resumed
before the WAL cursor was pinned.
`,
    );
    writeKnowledgeDoc(
      workspace,
      "docs/architecture/wal.md",
      `# WAL Architecture

The WAL layer must preserve replay ordering and deterministic cursor movement.
`,
    );
    writeKnowledgeDoc(
      workspace,
      "docs/solutions/README.md",
      `# Solutions

This README mentions wal recovery replay, but it is navigation material rather
than a canonical precedent.
`,
    );
    writeKnowledgeDoc(
      workspace,
      "docs/research/notes.md",
      `# Old Research Note

This note mentions replay experiments but is not the canonical precedent.
`,
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createKnowledgeSearchTool({ runtime });

    const result = await tool.execute(
      "tc-knowledge-search-main",
      {
        query: "wal recovery replay",
        module: "brewva-runtime",
        boundary: "runtime.turnWal",
        tags: ["wal"],
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as
      | {
          results?: Array<{
            path: string;
            sourceType: string;
            authorityRank: number;
            module: string | null;
            matchReasons: string[];
          }>;
          searchPlan?: {
            mode: string;
            broadened: boolean;
            solutionResultCount: number;
          };
        }
      | undefined;

    expect(text).toContain("# Knowledge Search");
    expect(text).toContain("source_type=solution");
    expect(text).toContain("search_mode: solution_then_bootstrap");
    expect(text).toContain("match_reasons=");
    expect(details?.results?.[0]?.path).toBe("docs/solutions/runtime-errors/wal-recovery-race.md");
    expect(details?.results?.[0]?.sourceType).toBe("solution");
    expect(details?.results?.[0]?.authorityRank).toBe(4);
    expect(details?.results?.[0]?.module).toBe("brewva-runtime");
    expect(details?.results?.[0]?.matchReasons).toEqual(
      expect.arrayContaining(["boundary_filter", "module_filter", "tags", "title"]),
    );
    expect(details?.searchPlan).toMatchObject({
      queryIntent: "precedent_lookup",
      mode: "solution_then_bootstrap",
      broadened: true,
      solutionResultCount: 1,
    });
  });

  test("filters by source type and reports no matches inconclusively", async () => {
    const workspace = createTestWorkspace("knowledge-search-filters");
    writeKnowledgeDoc(
      workspace,
      "docs/solutions/patterns/review-lanes.md",
      `---
title: Review lane guidance
status: active
problem_kind: knowledge
tags:
  - review
  - lanes
updated_at: 2026-03-31
---

# Review lane guidance

Always-on reviewer lanes should stay active even when metadata is incomplete.
`,
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createKnowledgeSearchTool({ runtime });

    const noMatch = await tool.execute(
      "tc-knowledge-search-no-match",
      {
        query: "review lanes",
        source_types: ["stable_doc"],
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );
    const noMatchText = extractText(noMatch as { content: Array<{ type: string; text?: string }> });
    expect(noMatchText).toContain("results: none");

    const filtered = await tool.execute(
      "tc-knowledge-search-filtered",
      {
        query: "review lanes",
        source_types: ["solution"],
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );
    const filteredDetails = filtered.details as
      | {
          results?: Array<{
            sourceType: string;
            path: string;
          }>;
        }
      | undefined;
    expect(filteredDetails?.results).toEqual([
      expect.objectContaining({
        sourceType: "solution",
        path: "docs/solutions/patterns/review-lanes.md",
      }),
    ]);
  });

  test("stays solution-only when the canonical corpus already has enough matches", async () => {
    const workspace = createTestWorkspace("knowledge-search-solution-only");
    writeKnowledgeDoc(
      workspace,
      "docs/solutions/runtime/replay-cursor-pinning.md",
      `---
title: Replay cursor pinning
status: active
problem_kind: bugfix
module: brewva-runtime
tags:
  - replay
  - wal
updated_at: 2026-03-31
---

# Replay cursor pinning

Pin the cursor before replay crosses an effectful boundary.
`,
    );
    writeKnowledgeDoc(
      workspace,
      "docs/solutions/runtime/replay-boundary-ordering.md",
      `---
title: Replay boundary ordering
status: active
problem_kind: bugfix
module: brewva-runtime
tags:
  - replay
  - wal
updated_at: 2026-03-31
---

# Replay boundary ordering

Keep ordering deterministic when replay resumes after rollback.
`,
    );
    writeKnowledgeDoc(
      workspace,
      "docs/architecture/replay.md",
      `# Replay Architecture

Architecture guidance for replay ordering.
`,
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createKnowledgeSearchTool({ runtime });

    const result = await tool.execute(
      "tc-knowledge-search-solution-only",
      {
        query: "replay wal",
        module: "brewva-runtime",
        tags: ["wal"],
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    const details = result.details as
      | {
          results?: Array<{ sourceType: string }>;
          searchPlan?: { mode: string; broadened: boolean; solutionResultCount: number };
        }
      | undefined;
    expect(details?.searchPlan).toMatchObject({
      queryIntent: "precedent_lookup",
      mode: "solution_only",
      broadened: false,
      solutionResultCount: 2,
    });
    expect(details?.results?.every((entry) => entry.sourceType === "solution")).toBe(true);
  });

  test("uses query-intent-aware ranking when normative lookup is requested", async () => {
    const workspace = createTestWorkspace("knowledge-search-normative");
    writeKnowledgeDoc(
      workspace,
      "docs/solutions/runtime/wal-guidance.md",
      `---
title: WAL guidance
status: active
problem_kind: knowledge
module: brewva-runtime
tags:
  - wal
updated_at: 2026-03-31
---

# WAL guidance

Prefer cursor pinning before replay resumes.
`,
    );
    writeKnowledgeDoc(
      workspace,
      "docs/reference/wal-contract.md",
      `---
title: WAL contract
module: brewva-runtime
tags:
  - wal
---

# WAL contract

Replay ordering and cursor movement are normative runtime contracts.
`,
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createKnowledgeSearchTool({ runtime });
    const result = await tool.execute(
      "tc-knowledge-search-normative",
      {
        query: "wal contract cursor replay",
        query_intent: "normative_lookup",
        module: "brewva-runtime",
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    const details = result.details as
      | {
          results?: Array<{ sourceType: string; path: string; authorityRank: number }>;
          searchPlan?: { queryIntent: string };
        }
      | undefined;
    expect(details?.searchPlan?.queryIntent).toBe("normative_lookup");
    expect(details?.results?.[0]).toEqual(
      expect.objectContaining({
        sourceType: "stable_doc",
        path: "docs/reference/wal-contract.md",
        authorityRank: 1,
      }),
    );
  });
});
