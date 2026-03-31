import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createPrecedentSweepTool } from "@brewva/brewva-tools";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

let workspace = "";

afterEach(() => {
  if (workspace) {
    cleanupWorkspace(workspace);
    workspace = "";
  }
});

function writeRepoFile(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

describe("precedent sweep tool", () => {
  test("runs an explicit repository-wide maintenance sweep and reports only actionable docs by default", async () => {
    workspace = createTestWorkspace("precedent-sweep-actionable");
    writeRepoFile(
      workspace,
      "docs/reference/runtime-wal-replay.md",
      [
        "---",
        "title: WAL recovery race during replay",
        "module: brewva-runtime",
        "boundaries:",
        "  - runtime.turnWal",
        "tags:",
        "  - wal",
        "  - recovery",
        "---",
        "# WAL recovery race during replay",
        "",
        "## Guidance",
        "",
        "Pin the WAL cursor before replay crosses the effect boundary.",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      workspace,
      "docs/solutions/brewva-runtime/wal-recovery-race-during-replay.md",
      [
        "---",
        "id: sol-2026-03-31-wal-recovery-race",
        "title: WAL recovery race during replay",
        "status: active",
        "problem_kind: knowledge",
        "module: brewva-runtime",
        "boundaries:",
        "  - runtime.turnWal",
        "source_artifacts:",
        "  - retro_findings",
        "tags:",
        "  - wal",
        "  - recovery",
        "updated_at: 2026-03-31",
        "---",
        "# WAL recovery race during replay",
        "",
        "## Guidance",
        "",
        "Preserve deterministic replay ordering around the WAL cursor.",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      workspace,
      "docs/solutions/brewva-runtime/legacy-replay-shortcut.md",
      [
        "---",
        "id: sol-2026-03-28-legacy-replay-shortcut",
        "title: Legacy replay shortcut",
        "status: stale",
        "problem_kind: knowledge",
        "module: brewva-runtime",
        "source_artifacts:",
        "  - retro_findings",
        "updated_at: 2026-03-28",
        "---",
        "# Legacy replay shortcut",
        "",
        "## Guidance",
        "",
        "Do not rely on the old replay shortcut after the recovery contract changed.",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      workspace,
      "docs/solutions/brewva-runtime/clean-replay-guidance.md",
      [
        "---",
        "id: sol-2026-03-20-clean-replay-guidance",
        "title: Clean replay guidance",
        "status: active",
        "problem_kind: knowledge",
        "module: brewva-gateway",
        "source_artifacts:",
        "  - retro_findings",
        "updated_at: 2026-03-20",
        "---",
        "# Clean replay guidance",
        "",
        "## Guidance",
        "",
        "Keep replay ordering deterministic around effect boundaries.",
        "",
      ].join("\n"),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createPrecedentSweepTool({ runtime });
    const result = await tool.execute(
      "tc-precedent-sweep-actionable",
      {} as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    expect(result.details).toMatchObject({
      verdict: "fail",
      totalDocs: 3,
      auditedDocs: 3,
      actionableDocs: 2,
      emittedDocs: 2,
      truncated: false,
    });
    const entries =
      (
        result.details as {
          entries?: Array<{
            path?: string;
            maintenanceRecommendation?: string;
            findingCodes?: string[];
          }>;
        }
      ).entries ?? [];
    expect(entries).toHaveLength(2);
    expect(
      entries.some(
        (entry) =>
          entry.path === "docs/solutions/brewva-runtime/wal-recovery-race-during-replay.md" &&
          entry.maintenanceRecommendation === "review_for_drift" &&
          entry.findingCodes?.includes("higher_authority_overlap"),
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.path === "docs/solutions/brewva-runtime/legacy-replay-shortcut.md" &&
          entry.maintenanceRecommendation === "complete_derivative_routing" &&
          entry.findingCodes?.includes("invalid_solution_record"),
      ),
    ).toBe(true);
    expect(
      entries.every(
        (entry) => entry.path !== "docs/solutions/brewva-runtime/clean-replay-guidance.md",
      ),
    ).toBe(true);
  });

  test("returns inconclusive when the repository has no solution docs yet", async () => {
    workspace = createTestWorkspace("precedent-sweep-empty");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createPrecedentSweepTool({ runtime });
    const result = await tool.execute(
      "tc-precedent-sweep-empty",
      {} as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    expect(result.details).toMatchObject({
      verdict: "inconclusive",
      totalDocs: 0,
      auditedDocs: 0,
      actionableDocs: 0,
    });
  });
});
