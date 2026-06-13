import { describe, expect, test } from "bun:test";
import { projectDelegationInspectionState } from "@brewva/brewva-session-index";
import { createWorkflowStatusTool } from "@brewva/brewva-tools/workflow";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import type { DelegationInspectionProjection } from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

const SESSION = "workflow-status-adoption-session";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function workerRunPayload(status: "pending" | "completed", updatedAt: number) {
  return {
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    runId: "worker-1",
    agent: "worker",
    targetName: "worker",
    delegate: "worker",
    taskName: "Implement fix",
    label: "Implement fix",
    depth: 1,
    forkTurns: "none",
    gateReason: "implement_isolated",
    modelCategory: "isolated-execution",
    visibility: "public",
    isolationStrategy: "snapshot",
    lifecycleReason: "none",
    retention: "live",
    createdAt: 1_000,
    updatedAt,
    kind: "patch",
    status,
    summary: "Prepared a patch.",
    resultData: { kind: "patch", patches: { id: "patch-worker-1", changes: [] } },
    patches: { id: "patch-worker-1", changes: [] },
  };
}

function pendingPatchInspection(): DelegationInspectionProjection {
  const records: BrewvaEventRecord[] = [
    {
      id: "evt-spawn",
      sessionId: SESSION,
      turn: 1,
      type: SUBAGENT_SPAWNED_EVENT_TYPE,
      timestamp: 1_000,
      payload: workerRunPayload("pending", 1_000),
    },
    {
      id: "evt-done",
      sessionId: SESSION,
      turn: 1,
      type: SUBAGENT_COMPLETED_EVENT_TYPE,
      timestamp: 1_100,
      payload: workerRunPayload("completed", 1_100),
    },
  ];
  return projectDelegationInspectionState({ sessionId: SESSION, records });
}

describe("workflow_status adoption board surfacing", () => {
  test("surfaces adoption items with their resolving tool calls", async () => {
    const inspection = pendingPatchInspection();
    expect(inspection.adoptionBoard.adoptionItems).toHaveLength(1);

    const runtime = createRuntimeFixture();
    const tool = createWorkflowStatusTool({
      runtime: createBundledToolRuntime(runtime, {
        delegation: {
          inspect: () => inspection,
        },
      }),
    });

    const result = await tool.execute(
      "workflow-status-1",
      {},
      new AbortController().signal,
      async () => undefined,
      { sessionManager: { getSessionId: () => SESSION } } as never,
    );

    const text = extractText(result);
    expect(text).toContain("adoption_items: 1");
    expect(text).toContain("worker_results_apply [apply]");
    expect(text).toContain("worker_results_reject [reject]");

    const details = toolOutcomePayload(result) as {
      adoptionItems: Array<{ runId: string; kind: string }>;
      attentionItems: unknown[];
    };
    expect(details.adoptionItems).toHaveLength(1);
    expect(details.adoptionItems[0]).toMatchObject({ runId: "worker-1", kind: "worker_patch" });
  });

  test("reports an empty board when delegation inspection is unavailable", async () => {
    const runtime = createRuntimeFixture();
    const tool = createWorkflowStatusTool({
      runtime: createBundledToolRuntime(runtime),
    });

    const result = await tool.execute(
      "workflow-status-2",
      {},
      new AbortController().signal,
      async () => undefined,
      { sessionManager: { getSessionId: () => SESSION } } as never,
    );

    const text = extractText(result);
    expect(text).toContain("adoption_items: 0");
    expect(text).toContain("attention_items: 0");
  });
});
