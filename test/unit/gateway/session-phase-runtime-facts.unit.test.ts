import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
  type SessionWireFrame,
} from "@brewva/brewva-runtime";
import {
  deriveSessionPhaseFromRuntimeFactFrame,
  deriveSessionPhaseFromRuntimeFactHistory,
} from "../../../packages/brewva-gateway/src/session/session-phase-runtime-facts.js";

describe("session phase runtime facts", () => {
  test("preserves tool identity when approval is requested", () => {
    const frame: SessionWireFrame = {
      schema: "brewva.session-wire.v2",
      sessionId: asBrewvaSessionId("session-1"),
      frameId: "frame-1",
      ts: Date.now(),
      source: "replay",
      durability: "durable",
      type: "approval.requested",
      turnId: "turn-1",
      requestId: "approval-1",
      toolCallId: asBrewvaToolCallId("tool-1"),
      toolName: asBrewvaToolName("exec_command"),
      subject: "tool:exec_command",
    };

    expect(deriveSessionPhaseFromRuntimeFactFrame({ kind: "idle" }, frame, 1)).toEqual({
      phase: {
        kind: "waiting_approval",
        requestId: "approval-1",
        toolCallId: "tool-1",
        toolName: "exec_command",
        turn: 1,
      },
      reason: "approval_requested",
      detail: "tool:exec_command",
    });
  });

  test("retains tool identity across approval transitions reconstructed from history", () => {
    const frames: SessionWireFrame[] = [
      {
        schema: "brewva.session-wire.v2",
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-input",
        ts: Date.now(),
        source: "replay",
        durability: "durable",
        type: "turn.input",
        turnId: "turn-1",
        trigger: "user",
        promptText: "run the tool",
      },
      {
        schema: "brewva.session-wire.v2",
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-approval",
        ts: Date.now() + 1,
        source: "replay",
        durability: "durable",
        type: "approval.requested",
        turnId: "turn-1",
        requestId: "approval-1",
        toolCallId: asBrewvaToolCallId("tool-1"),
        toolName: asBrewvaToolName("exec_command"),
        subject: "tool:exec_command",
      },
    ];

    expect(deriveSessionPhaseFromRuntimeFactHistory("session-1", frames)).toEqual({
      phase: {
        kind: "waiting_approval",
        requestId: "approval-1",
        toolCallId: "tool-1",
        toolName: "exec_command",
        turn: 1,
      },
      reason: "approval_requested",
      detail: "tool:exec_command",
    });
  });
});
