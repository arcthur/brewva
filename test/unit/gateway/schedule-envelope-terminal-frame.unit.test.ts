import { describe, expect, test } from "bun:test";
import { validateSessionWireFramePayload } from "@brewva/brewva-vocabulary/wire";
import { buildTerminalTurnFailedFrame } from "../../../packages/brewva-gateway/src/hosted/edge/worker/terminal-frame.js";

// When the schedule approval envelope cannot converge (resume cap tripped, a
// suspension with no pending approval, or a thrown decide()/resume), the worker
// synthesizes this terminal frame so the supervisor's pending `waitForCompletion`
// send resolves instead of hanging until its timeout. The frame must be a VALID
// `turn.committed` wire frame keyed by the original turnId — otherwise the parent
// drops it and the hang persists.
describe("schedule envelope terminal frame", () => {
  const frame = buildTerminalTurnFailedFrame({
    sessionId: "schedule:policy:self-improve:recurring:7",
    turnId: "turn-abc",
    failureReason: "schedule_envelope_suspended",
    attemptId: "runtime-turn",
  });

  test("is a valid session wire frame", () => {
    const validated = validateSessionWireFramePayload(frame);
    expect(validated.ok).toBe(true);
  });

  test("is a failed turn.committed keyed by the original turnId", () => {
    expect(frame.type).toBe("turn.committed");
    expect(frame).toMatchObject({
      turnId: "turn-abc",
      status: "failed",
      failureReason: "schedule_envelope_suspended",
      assistantText: "",
      toolOutputs: [],
    });
  });

  test("carries durable provenance so it is not rejected as a control frame", () => {
    // The wire contract requires durable frames to carry source provenance;
    // a missing sourceEventId/Type would fail validation and be dropped.
    expect(frame.durability).toBe("durable");
    expect(frame.source).toBe("live");
    const record = frame as unknown as Record<string, unknown>;
    expect(typeof record.sourceEventId).toBe("string");
    expect((record.sourceEventId as string).length).toBeGreaterThan(0);
    expect(typeof record.sourceEventType).toBe("string");
  });
});
