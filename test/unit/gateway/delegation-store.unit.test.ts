import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
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
  kind?: "review" | "plan";
  delegate?: string;
}): void {
  input.runtime.events.record({
    sessionId: input.sessionId,
    type: "subagent_completed",
    timestamp: input.updatedAt,
    payload: {
      runId: input.runId,
      delegate: input.delegate ?? input.kind ?? "review",
      status: "completed",
      kind: input.kind ?? "review",
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

    runtime.events.record({
      sessionId,
      type: "subagent_spawned",
      timestamp: 100,
      payload: {
        runId: "run-1",
        delegate: "review",
        status: "pending",
      },
    });
    runtime.events.record({
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

    runtime.events.record({
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

  test("preserves canonical plan kinds in read models", () => {
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-plan-kind";

    recordCompletedRun({
      runtime,
      sessionId,
      runId: "run-plan-kind",
      updatedAt: 100,
      handoffState: "surfaced",
      kind: "plan",
      delegate: "plan",
    });

    expect(store.getRun(sessionId, "run-plan-kind")).toMatchObject({
      runId: "run-plan-kind",
      status: "completed",
      kind: "plan",
    });
  });
});
