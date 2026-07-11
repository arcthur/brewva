import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";

/**
 * Build a terminal `turn.committed` failure frame for a turn the runtime never
 * drove to `turn.ended` (so the normal projection never emitted one). The
 * supervisor resolves a pending `waitForCompletion` send on exactly this frame
 * keyed by turnId; without it the schedule runner waits out its timeout.
 *
 * Used only for the schedule approval-envelope non-convergence paths (resume cap
 * tripped, suspension with no pending approval, or a thrown decide()/resume),
 * whose worker session is ephemeral — stopped right after the run — so the
 * synthetic terminal never has to reconcile with lingering runtime turn state.
 * `sourceEventId`/`sourceEventType` are synthetic-but-non-empty so the frame
 * satisfies the wire contract's durable-provenance requirement.
 */
export function buildTerminalTurnFailedFrame(input: {
  sessionId: string;
  turnId: string;
  failureReason: string;
  attemptId: string;
}): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: input.sessionId,
    frameId: `schedule-envelope-terminal:${input.turnId}`,
    ts: Date.now(),
    source: "live",
    durability: "durable",
    sourceEventId: `synthetic:schedule-envelope:${input.turnId}`,
    sourceEventType: "turn.ended",
    type: "turn.committed",
    turnId: input.turnId,
    attemptId: input.attemptId,
    status: "failed",
    failureReason: input.failureReason,
    assistantText: "",
    assistantSegments: [],
    toolOutputs: [],
  };
}
