import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createKnowledgeCaptureTool } from "@brewva/brewva-tools";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

let workspace = "";

afterEach(() => {
  if (workspace) {
    cleanupWorkspace(workspace);
    workspace = "";
  }
});

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function writeRepoFile(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

describe("knowledge capture tool", () => {
  test("creates a canonical solution record with derivative links and discoverability status", async () => {
    workspace = createTestWorkspace("knowledge-capture-create");
    writeRepoFile(
      workspace,
      "AGENTS.md",
      "Consult docs/solutions and knowledge_search before non-trivial planning.\n",
    );
    writeRepoFile(
      workspace,
      "README.md",
      "This repository keeps precedents in docs/solutions for explicit retrieval.\n",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createKnowledgeCaptureTool({ runtime });

    const result = await tool.execute(
      "tc-knowledge-capture-create",
      {
        solution_record: {
          title: "WAL recovery race during replay",
          problem_kind: "bugfix",
          module: "brewva-runtime",
          boundaries: ["runtime.turnWal", "runtime.tools"],
          source_artifacts: ["investigation_record", "review_findings", "retro_findings"],
          tags: ["wal", "recovery"],
          sections: [
            {
              heading: "Problem",
              body: "Replay resumed before the WAL cursor was pinned.",
            },
            {
              heading: "Failed Attempts",
              body: "Route ownership changes did not eliminate duplicate effect authorization.",
            },
            {
              heading: "Solution",
              body: "Pin the WAL cursor before boundary checks and replay authorization.",
            },
            {
              heading: "Why This Works",
              body: "Replay ordering now remains deterministic across recovery boundaries.",
            },
          ],
          derivative_links: [
            {
              relation: "related",
              target_kind: "promotion_candidate",
              ref: ".brewva/skill-broker/materialized/runtime-rules/wal-recovery",
              note: "follow-up protocol refinement",
            },
          ],
        },
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    const details = result.details as
      | {
          captureStatus?: string;
          solutionDocPath?: string;
          solutionId?: string;
          discoverability?: { status?: string };
          precedentAudit?: { verdict?: string; maintenanceRecommendation?: string };
        }
      | undefined;
    expect(details?.captureStatus).toBe("created");
    expect(details?.solutionDocPath).toBe(
      "docs/solutions/brewva-runtime/wal-recovery-race-during-replay.md",
    );
    expect(details?.solutionId).toMatch(/^sol-\d{4}-\d{2}-\d{2}-wal-recovery-race-during-replay$/);
    expect(details?.discoverability?.status).toBe("ok");
    expect(details?.precedentAudit?.verdict).toBe("pass");
    expect(details?.precedentAudit?.maintenanceRecommendation).toBe("none");

    const written = readFileSync(
      join(workspace, "docs/solutions/brewva-runtime/wal-recovery-race-during-replay.md"),
      "utf8",
    );
    expect(written).toContain("problem_kind: bugfix");
    expect(written).toContain("source_artifacts:");
    expect(written).toContain("## Failed Attempts");
    expect(written).toContain("## Derivative Links");
    expect(written).toContain("related -> promotion_candidate");
    expect(extractText(result as { content: Array<{ type: string; text?: string }> })).toContain(
      "status: created",
    );
  });

  test("skips a no-op update when only updated_at would change implicitly", async () => {
    workspace = createTestWorkspace("knowledge-capture-skip");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createKnowledgeCaptureTool({ runtime });
    const solutionDocPath = "docs/solutions/runtime/wal-cursor-pinning.md";

    await tool.execute(
      "tc-knowledge-capture-seed",
      {
        solution_doc_path: solutionDocPath,
        solution_record: {
          title: "WAL cursor pinning",
          problem_kind: "knowledge",
          source_artifacts: ["retro_findings"],
          updated_at: "2026-03-15",
          sections: [
            {
              heading: "Guidance",
              body: "Pin the cursor before replay crosses an effectful boundary.",
            },
          ],
        },
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    const second = await tool.execute(
      "tc-knowledge-capture-skip",
      {
        solution_doc_path: solutionDocPath,
        solution_record: {
          title: "WAL cursor pinning",
          problem_kind: "knowledge",
          source_artifacts: ["retro_findings"],
          sections: [
            {
              heading: "Guidance",
              body: "Pin the cursor before replay crosses an effectful boundary.",
            },
          ],
        },
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    const details = second.details as
      | {
          captureStatus?: string;
          solutionDocPath?: string;
        }
      | undefined;
    expect(details?.captureStatus).toBe("skipped");
    expect(details?.solutionDocPath).toBe(solutionDocPath);

    const written = readFileSync(join(workspace, solutionDocPath), "utf8");
    expect(written).toContain("updated_at: 2026-03-15");
  });

  test("rejects bugfix capture without investigation-grade authority", async () => {
    workspace = createTestWorkspace("knowledge-capture-invalid");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createKnowledgeCaptureTool({ runtime });

    const result = await tool.execute(
      "tc-knowledge-capture-invalid",
      {
        solution_record: {
          title: "Replay deduplication bug",
          problem_kind: "bugfix",
          source_artifacts: ["review_findings"],
          sections: [
            {
              heading: "Problem",
              body: "Replay produced duplicate authorizations.",
            },
            {
              heading: "Solution",
              body: "Move deduplication earlier.",
            },
          ],
        },
      } as never,
      undefined,
      undefined,
      { cwd: workspace } as never,
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("investigation_record");
    expect(text).toContain("Failed Attempts");
    expect(result.details).toMatchObject({
      verdict: "fail",
      error: "invalid_solution_record",
    });
  });

  test("rejects stale capture that does not route to a stable doc or successor precedent", async () => {
    workspace = createTestWorkspace("knowledge-capture-stale-routing");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createKnowledgeCaptureTool({ runtime });

    const result = await tool.execute(
      "tc-knowledge-capture-stale-routing",
      {
        solution_record: {
          title: "Old replay workaround",
          status: "stale",
          problem_kind: "knowledge",
          source_artifacts: ["retro_findings"],
          sections: [
            {
              heading: "Guidance",
              body: "Avoid the old replay shortcut after the contract update landed.",
            },
          ],
          derivative_links: [
            {
              relation: "related",
              target_kind: "promotion_candidate",
              ref: ".brewva/skill-broker/materialized/runtime-rules/replay-guidance",
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
      error: "precedent_audit_failed",
    });
    expect(
      (
        result.details as { precedentAudit?: { findings?: Array<{ code?: string }> } }
      ).precedentAudit?.findings?.some((finding) => finding.code === "missing_displacement_link"),
    ).toBe(true);
    expect(extractText(result as { content: Array<{ type: string; text?: string }> })).toContain(
      "complete_derivative_routing",
    );
  });
});
