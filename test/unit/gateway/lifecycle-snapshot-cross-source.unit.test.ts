import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import type { SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import {
  deriveSessionStatusSeedFromHistory,
  deriveSessionStatusSeedFromLifecycleSnapshot,
} from "../../../packages/brewva-gateway/src/daemon/internal/session-wire-status.js";
import {
  deriveSessionPhaseFromLifecycleSnapshot,
  deriveSessionPhaseFromRuntimeFactHistory,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/session-phase/api.js";
import {
  createLifecycleOps,
  type FourPortLifecycleScenario,
} from "../../helpers/four-port-lifecycle.js";

const SESSION_ID = asBrewvaSessionId("cross-source");

/**
 * Drives the REAL four-port lifecycle producer (via the shared helper) so the snapshot
 * under test comes from the producer, never a hand-built literal that could drift from
 * it — the whole point of the cross-source guarantee.
 */
function producerSnapshot(scenario: FourPortLifecycleScenario): SessionLifecycleSnapshot {
  return createLifecycleOps(scenario).getSnapshot(SESSION_ID);
}

function turnInputFrame(): Extract<SessionWireFrame, { type: "turn.input" }> {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: SESSION_ID,
    frameId: "turn-input",
    ts: 1,
    source: "live",
    durability: "durable",
    type: "turn.input",
    turnId: "turn-1",
    trigger: "user",
    promptText: "do work",
  };
}

function recoveryEnteredFrame(): Extract<SessionWireFrame, { type: "turn.transition" }> {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: SESSION_ID,
    frameId: "recovery-entered",
    ts: 2,
    source: "live",
    durability: "durable",
    type: "turn.transition",
    turnId: "turn-1",
    reason: "wal_recovery_resume",
    status: "entered",
    family: "recovery",
  };
}

function approvalRequestedFrame(): Extract<SessionWireFrame, { type: "approval.requested" }> {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: SESSION_ID,
    frameId: "approval-requested",
    ts: 2,
    source: "live",
    durability: "durable",
    type: "approval.requested",
    turnId: "turn-1",
    requestId: "req-1",
    toolName: asBrewvaToolName("shell"),
    toolCallId: asBrewvaToolCallId("tool-1"),
    subject: "Run guarded command",
  };
}

// These guard the Tier 1 blast radius: the daemon replay-seed and bootstrap phase now
// begin emitting from the snapshot where they previously always fell through to the
// frame-history path. The snapshot path must AGREE with the frame-history path (same
// terminal state/phase kind) for a mid-recovery session, and must correctly DEFER
// (yield null, letting the richer frame-history path win) for an approval wait whose
// requestId/toolName/subject the four-port tape cannot see.
describe("lifecycle snapshot vs frame-history cross-source agreement", () => {
  test("a mid-recovery session derives the same restarting seed from either source", () => {
    const snapshot = producerSnapshot({
      active: true,
      lastEventType: "runtime.suspended",
      lastCause: "compaction_required",
    });
    const snapshotSeed = deriveSessionStatusSeedFromLifecycleSnapshot(snapshot);
    const historySeed = deriveSessionStatusSeedFromHistory(
      SESSION_ID,
      [turnInputFrame(), recoveryEnteredFrame()],
      "idle",
    );
    // Reason/detail are source-specific vocabularies (suspend cause vs transition
    // reason); the load-bearing agreement is the terminal state the daemon acts on.
    expect(snapshotSeed?.state).toBe("restarting");
    expect(historySeed.state).toBe("restarting");
    expect(snapshotSeed?.state).toBe(historySeed.state);
  });

  test("a mid-recovery session derives the same recovering phase kind from either source", () => {
    const snapshot = producerSnapshot({
      active: true,
      lastEventType: "runtime.suspended",
      lastCause: "compaction_required",
    });
    const snapshotPhase = deriveSessionPhaseFromLifecycleSnapshot(snapshot, 1);
    const historyPhase = deriveSessionPhaseFromRuntimeFactHistory(SESSION_ID, [
      turnInputFrame(),
      recoveryEnteredFrame(),
    ]);
    expect(snapshotPhase?.phase.kind).toBe("recovering");
    expect(historyPhase.phase.kind).toBe("recovering");
    expect(snapshotPhase?.phase.kind).toBe(historyPhase.phase.kind);
  });

  test("an approval wait defers to frame history for the seed instead of emitting a false one", () => {
    const snapshot = producerSnapshot({
      active: true,
      lastEventType: "runtime.suspended",
      lastCause: "approval_pending",
    });
    // The snapshot cannot see the approval subject/requestId, so it must NOT seed —
    // the frame-history path carries the real waiting_approval seed.
    expect(deriveSessionStatusSeedFromLifecycleSnapshot(snapshot)).toBeNull();
    expect(
      deriveSessionStatusSeedFromHistory(
        SESSION_ID,
        [turnInputFrame(), approvalRequestedFrame()],
        "idle",
      ).state,
    ).toBe("waiting_approval");
  });

  test("an approval wait defers to frame history for the phase instead of emitting a false one", () => {
    const snapshot = producerSnapshot({
      active: true,
      lastEventType: "runtime.suspended",
      lastCause: "approval_pending",
    });
    expect(deriveSessionPhaseFromLifecycleSnapshot(snapshot, 1)).toBeNull();
    expect(
      deriveSessionPhaseFromRuntimeFactHistory(SESSION_ID, [
        turnInputFrame(),
        approvalRequestedFrame(),
      ]).phase.kind,
    ).toBe("waiting_approval");
  });
});
