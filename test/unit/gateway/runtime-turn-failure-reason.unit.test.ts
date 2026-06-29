import { describe, expect, test } from "bun:test";
import type { TurnFrame } from "@brewva/brewva-runtime";
import { validateSessionWireFramePayload } from "@brewva/brewva-vocabulary/wire";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { emitRuntimeEventFrame } from "../../../packages/brewva-gateway/src/hosted/internal/turn/session-mux/runtime-frame-projection.js";
import { RuntimeWireToolLifecycleTracker } from "../../../packages/brewva-gateway/src/hosted/internal/turn/session-mux/runtime-wire-tool-lifecycle.js";
import {
  buildRuntimeTurnSessionWireFrames,
  runtimeTurnFailureReasonFromPayload,
} from "../../../packages/brewva-gateway/src/utils/runtime-session-wire-projection.js";

// The replay path (reopen / WAL recovery / reconnect) rebuilds frames from the
// canonical tape; the live path streams them as the turn runs. Both must carry
// the same failure reason so the CLI can render WHY a turn failed in every mode.
function committedFromReplay(
  turnEndedPayload: Record<string, unknown>,
): SessionWireFrame | undefined {
  const frames = buildRuntimeTurnSessionWireFrames({
    sessionId: "s1",
    events: [
      {
        id: "e1",
        sessionId: "s1",
        type: "turn.started",
        timestamp: 1,
        turnId: "turn-0",
        payload: { prompt: "hi" },
      },
      {
        id: "e2",
        sessionId: "s1",
        type: "turn.ended",
        timestamp: 2,
        turnId: "turn-0",
        payload: turnEndedPayload,
      },
    ],
  });
  return frames.find((wireFrame) => wireFrame.type === "turn.committed");
}

function committedFromLive(
  turnEndedPayload: Record<string, unknown>,
): SessionWireFrame | undefined {
  const frames: SessionWireFrame[] = [];
  let sequence = 0;
  emitRuntimeEventFrame({
    frame: {
      type: "runtime.event",
      event: {
        id: "e2",
        sessionId: "s1",
        type: "turn.ended",
        timestamp: 2,
        payload: turnEndedPayload,
      } as unknown as Extract<TurnFrame, { type: "runtime.event" }>["event"],
    },
    sessionId: "s1",
    turnId: "turn-0",
    attemptId: "attempt-0",
    profile: { name: "interactive" },
    tracker: new RuntimeWireToolLifecycleTracker(),
    onFrame: (wireFrame) => frames.push(wireFrame),
    nextSequence: () => (sequence += 1),
    assistantText: "",
    assistantSegments: [],
    toolOutputs: [],
    sequence: 1,
  });
  return frames.find((wireFrame) => wireFrame.type === "turn.committed");
}

function statusAndReason(
  frame: SessionWireFrame | undefined,
): { status: string; failureReason: string | undefined } | null {
  return frame?.type === "turn.committed"
    ? { status: frame.status, failureReason: frame.failureReason }
    : null;
}

describe("runtimeTurnFailureReasonFromPayload", () => {
  test("extracts a non-empty error string and rejects blank/non-string/non-record payloads", () => {
    expect([
      runtimeTurnFailureReasonFromPayload({ status: "failed", error: "Connection error." }),
      runtimeTurnFailureReasonFromPayload({ status: "completed" }),
      runtimeTurnFailureReasonFromPayload({ status: "failed", error: "   " }),
      runtimeTurnFailureReasonFromPayload({ status: "failed", error: 42 }),
      runtimeTurnFailureReasonFromPayload(null),
    ]).toEqual(["Connection error.", undefined, undefined, undefined, undefined]);
  });
});

describe("turn.committed projection carries the failure reason on both paths", () => {
  test("live and replay both project the provider reason for a failed turn", () => {
    // Regression: both projections dropped `error`, so the CLI only ever saw a
    // bare status and could not show WHY a turn failed.
    const expected = { status: "failed", failureReason: "Connection error." };
    expect({
      replay: statusAndReason(
        committedFromReplay({
          cause: "terminal_commit",
          status: "failed",
          error: "Connection error.",
        }),
      ),
      live: statusAndReason(
        committedFromLive({
          cause: "terminal_commit",
          status: "failed",
          error: "Connection error.",
        }),
      ),
    }).toEqual({ replay: expected, live: expected });
  });

  test("a completed turn omits failureReason on both paths", () => {
    const expected = { status: "completed", failureReason: undefined };
    expect({
      replay: statusAndReason(
        committedFromReplay({ cause: "terminal_commit", status: "completed" }),
      ),
      live: statusAndReason(committedFromLive({ cause: "terminal_commit", status: "completed" })),
    }).toEqual({ replay: expected, live: expected });
  });
});

describe("the wire validator guards failureReason across process boundaries", () => {
  test("a real failed frame round-trips through the validator with its reason intact", () => {
    const frame = committedFromReplay({
      cause: "terminal_commit",
      status: "failed",
      error: "Connection error.",
    });
    const validated = frame
      ? validateSessionWireFramePayload(frame)
      : ({ ok: false, error: "no frame" } as const);
    expect(
      validated.ok && validated.frame.type === "turn.committed"
        ? validated.frame.failureReason
        : null,
    ).toBe("Connection error.");
  });

  test("a frame whose failureReason is not a string is rejected (not silently kept)", () => {
    const frame = committedFromReplay({
      cause: "terminal_commit",
      status: "failed",
      error: "Connection error.",
    });
    const corrupted = { ...(frame as SessionWireFrame), failureReason: { not: "a string" } };
    expect(validateSessionWireFramePayload(corrupted).ok).toBe(false);
  });
});
