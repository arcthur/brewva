import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createWorkflowStatusTool } from "@brewva/brewva-tools";
import { extractTextContent, mergeContext } from "./tools-flow.helpers.js";

function withDelegationStatus(runtime: BrewvaRuntime, store: HostedDelegationStore) {
  const runtimeWithDelegation = Object.create(runtime) as BrewvaRuntime & {
    delegation: {
      listRuns: typeof store.listRuns;
      listPendingOutcomes: typeof store.listPendingOutcomes;
    };
  };
  runtimeWithDelegation.delegation = {
    listRuns: (sessionId, query) => store.listRuns(sessionId, query),
    listPendingOutcomes: (sessionId, query) => store.listPendingOutcomes(sessionId, query),
  };
  return runtimeWithDelegation;
}

describe("workflow_status contract", () => {
  test("reports stale review and verification after a later write", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-stale-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-stale";

    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Review ready.",
          review_findings: [],
          merge_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 110,
      payload: {
        outcome: "pass",
        level: "standard",
        activeSkill: "implementation",
        failedChecks: [],
        evidenceFreshness: "fresh",
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_write_marked",
      timestamp: 120,
      payload: {
        toolName: "edit",
      } as Record<string, unknown>,
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-stale",
      {
        include_artifacts: true,
        history_limit: 4,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[WorkflowStatus]");
    expect(text).toContain("review: stale");
    expect(text).toContain("verification: stale");
    expect(text).toContain("ship: blocked");
    expect(text).toContain("artifacts (latest 4):");
    expect(text).toContain("- review | state=ready | freshness=stale");
    expect(text).toContain("- verification | state=ready | freshness=stale");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
    expect(
      (
        result.details as
          | {
              posture?: { review?: string; ship?: string };
            }
          | undefined
      )?.posture,
    ).toEqual(
      expect.objectContaining({
        review: "stale",
        ship: "blocked",
      }),
    );
  });

  test("blocks ship posture while worker results are still pending", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-pending-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-pending";

    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Ready to merge.",
          review_findings: [],
          merge_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 110,
      payload: {
        outcome: "pass",
        level: "standard",
        failedChecks: [],
        evidenceFreshness: "fresh",
      } as Record<string, unknown>,
    });
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "worker-1",
      status: "ok",
      summary: "Patch result ready for merge/apply.",
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-pending",
      {},
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("implementation: pending");
    expect(text).toContain("qa: missing");
    expect(text).toContain("pending_worker_results: 1");
    expect(text).toContain("ship: blocked");
    expect(text).toContain("Pending worker results require merge/apply (1 result).");
    expect(
      (result.details as { pendingWorkerResults?: Array<{ workerId: string }> } | undefined)
        ?.pendingWorkerResults?.[0]?.workerId,
    ).toBe("worker-1");
  });

  test("reports pending delegation outcome handoffs alongside workflow posture", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-handoff-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-handoff";
    const delegationStore = new HostedDelegationStore(runtime);

    runtime.events.record({
      sessionId,
      type: "subagent_completed",
      payload: {
        runId: "delegation-handoff-1",
        delegate: "review",
        status: "completed",
        kind: "review",
        summary: "Review completed and is waiting for parent surfacing.",
        deliveryMode: "text_only",
        deliveryHandoffState: "pending_parent_turn",
        deliveryReadyAt: 2,
        deliveryUpdatedAt: 2,
      },
    });

    const tool = createWorkflowStatusTool({
      runtime: withDelegationStatus(runtime, delegationStore) as any,
    });
    const result = await tool.execute(
      "tc-workflow-status-handoff",
      {},
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("pending_delegation_outcomes: 1");
    expect(text).toContain("pending_delegation_outcome_runs:");
    expect(text).toContain("- review/delegation-handoff-1: completed");
    expect(
      (
        result.details as
          | {
              pendingDelegationOutcomes?: Array<{
                runId: string;
                delegate: string;
                label?: string;
                status: string;
                summary?: string;
                handoffState?: string | null;
              }>;
            }
          | undefined
      )?.pendingDelegationOutcomes,
    ).toEqual([
      {
        runId: "delegation-handoff-1",
        delegate: "review",
        label: undefined,
        status: "completed",
        summary: "Review completed and is waiting for parent surfacing.",
        handoffState: "pending_parent_turn",
      },
    ]);
  });

  test("surfaces the latest stall adjudication as advisory workflow state", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-stall-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-stall";

    runtime.events.record({
      sessionId,
      type: "task_stall_adjudicated",
      timestamp: 200,
      payload: {
        schema: "brewva.task-stall-adjudication.v1",
        detectedAt: 150,
        baselineProgressAt: 100,
        adjudicatedAt: 200,
        decision: "compact_recommended",
        source: "heuristic",
        rationale: "Tape pressure is high while the session is stalled.",
        signalSummary: ["tape_pressure_high", "recent_tool_failures=3"],
        tapePressure: "high",
        blockerCount: 0,
        blockedToolCount: 0,
        failureCount: 3,
        pendingWorkerResults: 0,
        verificationLastOutcome: "fail",
        verificationPassed: false,
        verificationSkipped: false,
      },
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-stall",
      {},
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("stall_adjudication: compact_recommended source=heuristic");
    expect(text).toContain("Tape pressure is high while the session is stalled.");
    expect(
      (
        result.details as
          | {
              stallAdjudication?: {
                decision: string;
                source: string;
                rationale: string;
              };
            }
          | undefined
      )?.stallAdjudication,
    ).toEqual(
      expect.objectContaining({
        decision: "compact_recommended",
        source: "heuristic",
        rationale: "Tape pressure is high while the session is stalled.",
      }),
    );
  });

  test("surfaces expanded workflow stages when specialist artifacts are present", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-expanded-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-expanded";

    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "discovery",
        outputKeys: ["problem_frame", "user_pains", "scope_recommendation"],
        outputs: {
          problem_frame: "Operators need clearer workflow visibility.",
          user_pains: ["Missing stages are easy to overlook."],
          scope_recommendation: "Start with advisory workflow state.",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 110,
      payload: {
        skillName: "strategy-review",
        outputKeys: ["strategy_review", "scope_decision", "strategic_risks"],
        outputs: {
          strategy_review: "Hold scope around advisory workflow state first.",
          scope_decision: "Do not build a planner.",
          strategic_risks: ["Duplicated status surfaces"],
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 120,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Review ready.",
          review_findings: [],
          merge_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 130,
      payload: {
        skillName: "qa",
        outputKeys: ["qa_report", "qa_findings", "qa_verdict", "qa_artifacts"],
        outputs: {
          qa_report: "Smoke-tested the operator path.",
          qa_findings: [],
          qa_verdict: "pass",
          qa_artifacts: ["snapshots/operator-flow.json"],
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 140,
      payload: {
        outcome: "pass",
        level: "standard",
        failedChecks: [],
        evidenceFreshness: "fresh",
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 150,
      payload: {
        skillName: "ship",
        outputKeys: ["ship_report", "release_checklist", "ship_decision"],
        outputs: {
          ship_report: "Ready for PR handoff.",
          release_checklist: ["CI green"],
          ship_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 160,
      payload: {
        skillName: "retro",
        outputKeys: ["retro_summary", "retro_findings", "followup_recommendation"],
        outputs: {
          retro_summary: "The chain stayed inspectable.",
          retro_findings: ["QA should consume risk_register next."],
          followup_recommendation: "Tighten QA inputs.",
        },
      } as Record<string, unknown>,
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-expanded",
      {
        include_artifacts: true,
        history_limit: 6,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("discovery: ready");
    expect(text).toContain("strategy: ready");
    expect(text).toContain("qa: ready");
    expect(text).toContain("ship: ready");
    expect(text).toContain("retro: ready");
    expect(text).toContain("- ship | state=ready | freshness=fresh");
    expect(text).toContain("- qa | state=ready | freshness=fresh");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("pass");
  });

  test("prefers core workflow artifacts over synthetic ship posture when artifacts are limited", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-limit-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-limit";

    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Ready to merge.",
          review_findings: [],
          merge_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 110,
      payload: {
        outcome: "pass",
        level: "standard",
        failedChecks: [],
        evidenceFreshness: "fresh",
      } as Record<string, unknown>,
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-limit",
      {
        include_artifacts: true,
        history_limit: 1,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("artifacts (latest 1):");
    expect(text).toContain("- verification | state=ready | freshness=fresh");
    expect(text).not.toContain("- ship_posture");
    expect(
      (result.details as { artifacts?: Array<{ kind: string }> } | undefined)?.artifacts?.[0]?.kind,
    ).toBe("verification");
  });

  test("surfaces acceptance as a separate closure posture", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-acceptance-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-acceptance";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Land the closure UX",
      acceptance: {
        required: true,
        owner: "operator",
        criteria: ["Operator accepts the result before done."],
      },
    });
    runtime.task.addItem(sessionId, {
      id: "item-1",
      text: "Finish the task",
      status: "done",
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-acceptance",
      {},
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("acceptance: pending");
    expect(text).toContain("ship: missing");
    expect(text).toContain("Acceptance required before closure.");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("inconclusive");
  });
});
