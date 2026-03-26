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
}): void {
  input.runtime.events.record({
    sessionId: input.sessionId,
    type: "subagent_completed",
    timestamp: input.updatedAt,
    payload: {
      runId: input.runId,
      delegate: "review",
      status: "completed",
      kind: "review",
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
});
