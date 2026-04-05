import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("delegation-store");
});

afterEach(() => {
  if (workspace) {
    cleanupWorkspace(workspace);
  }
});

function recordCompletedRun(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  runId: string;
  updatedAt: number;
  handoffState: "pending_parent_turn" | "surfaced";
  kind?: "consult";
  consultKind?: "review" | "design";
  delegate?: string;
}): void {
  recordRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: "subagent_completed",
    timestamp: input.updatedAt,
    payload: {
      runId: input.runId,
      delegate: input.delegate ?? "advisor",
      status: "completed",
      kind: input.kind ?? "consult",
      consultKind: input.consultKind ?? "review",
      summary: `run:${input.runId}`,
      deliveryMode: "text_only",
      deliveryHandoffState: input.handoffState,
      deliveryUpdatedAt: input.updatedAt,
      deliveryReadyAt: input.updatedAt,
      deliverySurfacedAt: input.handoffState === "surfaced" ? input.updatedAt : null,
    },
  });
}

describe("HostedDelegationStore", () => {
  test("listPendingOutcomes applies limit after filtering pending handoffs", () => {
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-limit";

    for (let index = 0; index < 6; index += 1) {
      recordCompletedRun({
        runtime,
        sessionId,
        runId: `surfaced-${index}`,
        updatedAt: 100 + index,
        handoffState: "surfaced",
      });
    }

    recordCompletedRun({
      runtime,
      sessionId,
      runId: "pending-older",
      updatedAt: 50,
      handoffState: "pending_parent_turn",
    });

    const pending = store.listPendingOutcomes(sessionId, { limit: 1 });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.runId).toBe("pending-older");
    expect(pending[0]?.delivery?.handoffState).toBe("pending_parent_turn");
  });

  test("replays subagent_running as the live lifecycle transition while keeping older spawned events compatible", () => {
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-running";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_spawned",
      timestamp: 100,
      payload: {
        runId: "run-1",
        delegate: "review",
        status: "pending",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_running",
      timestamp: 110,
      payload: {
        runId: "run-1",
        delegate: "review",
        status: "running",
        childSessionId: "child-1",
      },
    });

    expect(store.getRun(sessionId, "run-1")).toMatchObject({
      runId: "run-1",
      status: "running",
      workerSessionId: "child-1",
    });
  });

  test("does not preserve removed delegated verification kinds in read models", () => {
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-no-legacy-verification";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_completed",
      timestamp: 100,
      payload: {
        runId: "run-legacy-kind",
        delegate: "qa",
        status: "completed",
        kind: "verification",
        summary: "legacy verification run",
      },
    });

    expect(store.getRun(sessionId, "run-legacy-kind")).toMatchObject({
      runId: "run-legacy-kind",
      status: "completed",
      kind: undefined,
    });
  });

  test("preserves canonical design consult kinds in read models", () => {
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-design-consult";

    recordCompletedRun({
      runtime,
      sessionId,
      runId: "run-design-consult",
      updatedAt: 100,
      handoffState: "surfaced",
      kind: "consult",
      consultKind: "design",
      delegate: "advisor",
    });

    expect(store.getRun(sessionId, "run-design-consult")).toMatchObject({
      runId: "run-design-consult",
      status: "completed",
      kind: "consult",
      consultKind: "design",
    });
  });
});
