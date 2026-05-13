import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort, BrewvaToolRuntimePort } from "@brewva/brewva-runtime";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-runtime/delegation";
import { createWorkflowStatusTool } from "@brewva/brewva-tools/workflow";
import { extractTextContent, mergeContext } from "./tools-flow.helpers.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
}

function withDelegationStatus(runtime: BrewvaHostedRuntimePort, store: HostedDelegationStore) {
  return {
    identity: runtime.identity,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
    extensions: {
      tools: runtime.extensions.tools,
    },
    delegation: {
      listRuns: (sessionId, query) => store.listRuns(sessionId, query),
      listPendingOutcomes: (sessionId, query) => store.listPendingOutcomes(sessionId, query),
    },
  } satisfies BrewvaToolRuntimePort & {
    delegation: {
      listRuns: typeof store.listRuns;
      listPendingOutcomes: typeof store.listPendingOutcomes;
    };
  };
}

function recordVerificationOutcome(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  timestamp: number;
  outcome: "pass" | "fail";
  failedChecks?: string[];
  missingChecks?: string[];
  missingEvidence?: string[];
  evidenceFreshness?: "fresh" | "stale" | "mixed" | "none";
}) {
  input.runtime.extensions.hosted.events.record({
    sessionId: input.sessionId,
    type: "verification_outcome_recorded",
    timestamp: input.timestamp,
    payload: {
      outcome: input.outcome,
      level: "standard",
      failedChecks: input.failedChecks ?? [],
      missingChecks: input.missingChecks ?? [],
      missingEvidence: input.missingEvidence ?? [],
      evidenceFreshness: input.evidenceFreshness ?? "fresh",
    } as Record<string, unknown>,
  });
}

function recordDelegatedQa(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  timestamp: number;
  verdict: "pass" | "fail" | "inconclusive";
}) {
  input.runtime.extensions.hosted.events.record({
    sessionId: input.sessionId,
    type: "subagent_completed",
    timestamp: input.timestamp,
    payload: {
      runId: `qa-${input.timestamp}`,
      delegate: "qa",
      status: "completed",
      kind: "qa",
      summary: `Delegated QA verdict: ${input.verdict}.`,
      resultData: {
        kind: "qa",
        verdict: input.verdict,
        checks: [
          {
            name: "operator-smoke",
            status: input.verdict === "pass" ? "pass" : "inconclusive",
            command: "bun test",
            exit_code: input.verdict === "pass" ? 0 : 1,
            observed_output:
              input.verdict === "pass"
                ? "operator smoke passed"
                : "operator smoke remained inconclusive",
            probe_type: "adversarial",
            evidence_refs: ["snapshots/operator-flow.json"],
          },
        ],
      },
    },
  });
}

describe("workflow_status contract", () => {
  test("reports stale verification after a later write", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-stale-"));
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const sessionId = "workflow-status-stale";

    recordVerificationOutcome({
      runtime,
      sessionId,
      timestamp: 100,
      outcome: "pass",
    });
    runtime.extensions.hosted.events.record({
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
    expect(text).toContain("[Finish]");
    expect(text).toContain("state: blocked");
    expect(text).toContain("verified: false");
    expect(text).toContain("ship: missing");
    expect(text).toContain("Verification artifact is stale after later workspace mutations.");
    expect(text).toContain("artifacts (latest 4):");
    expect(text).toContain("- implementation | state=ready | freshness=fresh");
    expect(text).toContain("- verification | state=ready | freshness=stale");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("inconclusive");
  });

  test("blocks ship posture while worker results are still pending", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-pending-"));
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const sessionId = "workflow-status-pending";

    recordVerificationOutcome({
      runtime,
      sessionId,
      timestamp: 100,
      outcome: "pass",
    });
    runtime.authority.session.workerResults.record(sessionId, {
      workerId: "worker-1",
      status: "ok",
      summary: "Patch result ready for merge/apply.",
      patches: {
        id: "ps-workflow-status-1",
        createdAt: Date.now(),
        changes: [{ path: "src/workflow-status.ts", action: "modify" }],
      },
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
    expect(text).toContain("pending_worker_results: 1");
    expect(text).toContain("ship: missing");
    expect(text).toContain("Pending worker results require merge/apply (1 result).");
    expect(
      (result.details as { pendingWorkerResults?: Array<{ workerId: string }> } | undefined)
        ?.pendingWorkerResults?.[0]?.workerId,
    ).toBe("worker-1");
  });

  test("surfaces missing verification checks as explicit ship blockers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-missing-"));
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const sessionId = "workflow-status-missing";

    recordDelegatedQa({
      runtime,
      sessionId,
      timestamp: 100,
      verdict: "pass",
    });
    recordVerificationOutcome({
      runtime,
      sessionId,
      timestamp: 120,
      outcome: "fail",
      missingChecks: ["tests"],
      missingEvidence: ["tests"],
      evidenceFreshness: "none",
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-missing",
      {
        include_artifacts: true,
        history_limit: 4,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[Finish]");
    expect(text).toContain("state: blocked");
    expect(text).toContain("verified: false");
    expect(text).toContain("ship: missing");
    expect(text).toContain("Verification missing fresh evidence for tests.");
    expect(text).toContain("- qa | state=ready | freshness=fresh");
    expect(text).toContain("- verification | state=blocked | freshness=fresh");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  test("reports delegated QA as an advisory artifact without a skill output contract", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-qa-"));
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const sessionId = "workflow-status-qa";

    recordDelegatedQa({
      runtime,
      sessionId,
      timestamp: 100,
      verdict: "pass",
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-qa",
      {
        include_artifacts: true,
        history_limit: 2,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("qa: ready");
    expect(text).toContain("- qa | state=ready | freshness=fresh");
    expect(text).toContain("Delegated QA verdict: pass.");
    expect(
      (result.details as { artifacts?: Array<{ kind: string }> } | undefined)?.artifacts,
    ).toEqual([
      expect.objectContaining({ kind: "qa" }),
      expect.objectContaining({ kind: "ship_posture" }),
    ]);
  });

  test("reports pending delegation outcome handoffs alongside workflow posture", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-handoff-"));
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const sessionId = "workflow-status-handoff";
    const delegationStore = new HostedDelegationStore(runtime);

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "subagent_completed",
      payload: {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        executionPrimitive: "named",
        visibility: "public",
        isolationStrategy: "shared",
        runId: "delegation-handoff-1",
        delegate: "advisor",
        status: "completed",
        kind: "consult",
        consultKind: "review",
        summary: "Review completed and is waiting for parent surfacing.",
        deliveryMode: "text_only",
        deliveryHandoffState: "pending_parent_turn",
        deliveryReadyAt: 2,
        deliveryUpdatedAt: 2,
        adoption: {
          contractId: "delegation.consult.review",
          decision: "require_human",
          reason: "consult_adoption_requires_parent_judgment",
          requiredEvidence: ["consult_evidence"],
        },
      },
    });

    const tool = createWorkflowStatusTool({
      runtime: withDelegationStatus(runtime, delegationStore),
    });
    const result = await tool.execute(
      "tc-workflow-status-handoff",
      {},
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("state: blocked");
    expect(text).toContain("pending_delegation_outcomes: 1");
    expect(text).toContain("Pending delegation outcomes require parent attention (1 outcome).");
    expect(text).toContain("pending_delegation_outcome_runs:");
    expect(text).toContain("- advisor/delegation-handoff-1: completed");
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
        delegate: "advisor",
        label: undefined,
        status: "completed",
        summary: "Review completed and is waiting for parent surfacing.",
        handoffState: "pending_parent_turn",
      },
    ]);
  });

  test("surfaces the latest stall adjudication as advisory workflow state", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-stall-"));
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const sessionId = "workflow-status-stall";

    runtime.extensions.hosted.events.record({
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

  test("surfaces acceptance as a separate closure posture", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-acceptance-"));
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const sessionId = "workflow-status-acceptance";

    runtime.authority.task.spec.set(sessionId, {
      schema: "brewva.task.v1",
      goal: "Land the closure UX",
      acceptance: {
        required: true,
        criteria: ["Operator accepts the result before done."],
      },
    });
    runtime.authority.task.items.add(sessionId, {
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
