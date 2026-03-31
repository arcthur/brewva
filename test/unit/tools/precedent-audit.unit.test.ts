import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createPrecedentAuditTool } from "@brewva/brewva-tools";
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

describe("precedent audit tool", () => {
  test("surfaces higher-authority overlap as explicit drift maintenance work", async () => {
    workspace = createTestWorkspace("precedent-audit-drift");
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
        "Pin the WAL cursor before replay crosses an effectful boundary.",
        "",
      ].join("\n"),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createPrecedentAuditTool({ runtime });
    const result = await tool.execute(
      "tc-precedent-audit-drift",
      {
        solution_record: {
          title: "WAL recovery race during replay",
          problem_kind: "knowledge",
          module: "brewva-runtime",
          boundaries: ["runtime.turnWal"],
          source_artifacts: ["retro_findings"],
          tags: ["wal", "recovery"],
          sections: [
            {
              heading: "Guidance",
              body: "Preserve deterministic replay ordering around the WAL cursor.",
            },
          ],
        },
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    expect(result.details).toMatchObject({
      verdict: "inconclusive",
      maintenanceRecommendation: "review_for_drift",
    });
    expect((result.details as { stableDocRefs?: string[] }).stableDocRefs).toContain(
      "docs/reference/runtime-wal-replay.md",
    );
    expect((result.details as { querySummary?: string }).querySummary).toContain(
      "query_intent=normative_lookup",
    );
    expect((result.details as { querySummary?: string }).querySummary).toContain(
      "query_intent=precedent_lookup",
    );
    expect(
      (result.details as { findings?: Array<{ code?: string }> }).findings?.some(
        (finding) => finding.code === "higher_authority_overlap",
      ),
    ).toBe(true);
  });

  test("fails when an active solution record claims it was already superseded", async () => {
    workspace = createTestWorkspace("precedent-audit-status-conflict");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createPrecedentAuditTool({ runtime });
    const result = await tool.execute(
      "tc-precedent-audit-status-conflict",
      {
        solution_record: {
          title: "Workflow review disclosure shape",
          problem_kind: "knowledge",
          source_artifacts: ["retro_findings"],
          sections: [
            {
              heading: "Guidance",
              body: "Expose activated lanes and consulted precedent in the review report.",
            },
          ],
          derivative_links: [
            {
              relation: "superseded_by",
              target_kind: "solution_record",
              ref: "docs/solutions/workflow/review-disclosure-shape-v2.md",
            },
          ],
        },
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    expect(result.details).toMatchObject({
      verdict: "fail",
      maintenanceRecommendation: "mark_superseded",
    });
    expect(
      (result.details as { findings?: Array<{ code?: string }> }).findings?.some(
        (finding) => finding.code === "active_superseded_precedent",
      ),
    ).toBe(true);
  });

  test("surfaces same-rank conflicts between active peer solution records", async () => {
    workspace = createTestWorkspace("precedent-audit-same-rank-conflict");
    writeRepoFile(
      workspace,
      "docs/solutions/runtime/wal-recovery-race.md",
      [
        "---",
        "title: WAL recovery race during replay",
        "status: active",
        "problem_kind: bugfix",
        "module: brewva-runtime",
        "boundaries:",
        "  - runtime.turnWal",
        "tags:",
        "  - wal",
        "  - recovery",
        "updated_at: 2026-03-31",
        "---",
        "# WAL recovery race during replay",
        "",
        "## Solution",
        "",
        "Pin the WAL cursor before replay resumes and before authorization checks run.",
        "",
      ].join("\n"),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createPrecedentAuditTool({ runtime });
    const result = await tool.execute(
      "tc-precedent-audit-same-rank-conflict",
      {
        solution_record: {
          title: "WAL recovery race during replay",
          problem_kind: "bugfix",
          module: "brewva-runtime",
          boundaries: ["runtime.turnWal"],
          source_artifacts: ["investigation_record"],
          tags: ["wal", "recovery"],
          sections: [
            {
              heading: "Failed Attempts",
              body: "Moving authorization later still left replay and cursor reconciliation out of sync.",
            },
            {
              heading: "Solution",
              body: "Defer authorization until after replay completes and cursor reconciliation is finished.",
            },
          ],
        },
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    expect(result.details).toMatchObject({
      verdict: "inconclusive",
      maintenanceRecommendation: "review_for_drift",
    });
    expect(
      (result.details as { findings?: Array<{ code?: string }> }).findings?.some(
        (finding) => finding.code === "same_rank_conflict",
      ),
    ).toBe(true);
  });

  test("fails malformed promotion-candidate derivative links", async () => {
    workspace = createTestWorkspace("precedent-audit-promotion-link");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createPrecedentAuditTool({ runtime });
    const result = await tool.execute(
      "tc-precedent-audit-promotion-link",
      {
        solution_record: {
          title: "Review disclosure precedent",
          problem_kind: "knowledge",
          source_artifacts: ["retro_findings"],
          sections: [
            {
              heading: "Guidance",
              body: "Keep consulted precedent and lane disclosure explicit in the review report.",
            },
          ],
          derivative_links: [
            {
              relation: "related",
              target_kind: "promotion_candidate",
              ref: "docs/solutions/workflow/review-disclosure.md",
            },
          ],
        },
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    expect(result.details).toMatchObject({
      verdict: "fail",
      maintenanceRecommendation: "complete_derivative_routing",
    });
    expect(
      (result.details as { findings?: Array<{ code?: string }> }).findings?.some(
        (finding) => finding.code === "invalid_promotion_candidate_ref",
      ),
    ).toBe(true);
  });
});
