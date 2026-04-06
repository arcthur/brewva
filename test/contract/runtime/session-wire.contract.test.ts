import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";

function createRuntime(): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-session-wire-")),
  });
}

describe("runtime session wire compiler", () => {
  test("replays committed turn receipts without standalone tool finished frames", () => {
    const runtime = createRuntime();
    const sessionId = "session-wire-simple";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_input_recorded",
      turn: 0,
      payload: {
        turnId: "turn-1",
        trigger: "user",
        promptText: "hello world",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_render_committed",
      turn: 0,
      payload: {
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "done",
        toolOutputs: [
          {
            toolCallId: "tool-1",
            toolName: "exec",
            verdict: "pass",
            isError: false,
            text: "ok",
          },
        ],
      },
    });

    const frames = runtime.inspect.sessionWire.query(sessionId);
    expect(frames.map((frame) => frame.type)).toEqual(["turn.input", "turn.committed"]);
    expect(frames.every((frame) => frame.schema === "brewva.session-wire.v2")).toBe(true);
    expect(frames.every((frame) => frame.source === "replay")).toBe(true);
    expect(frames.every((frame) => frame.durability === "durable")).toBe(true);
    expect(frames.every((frame) => typeof frame.sourceEventId === "string")).toBe(true);
    expect(frames.every((frame) => typeof frame.sourceEventType === "string")).toBe(true);
    expect(frames.find((frame) => frame.type === "tool.finished")).toBeUndefined();
    expect(frames[1]).toMatchObject({
      type: "turn.committed",
      turnId: "turn-1",
      attemptId: "attempt-1",
      assistantText: "done",
      toolOutputs: [
        {
          toolCallId: "tool-1",
          toolName: "exec",
          verdict: "pass",
          isError: false,
          text: "ok",
        },
      ],
    });
  });

  test("derives durable attempt lifecycle from transition history", () => {
    const runtime = createRuntime();
    const sessionId = "session-wire-attempts";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_input_recorded",
      turn: 0,
      payload: {
        turnId: "turn-2",
        trigger: "user",
        promptText: "retry this",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      turn: 0,
      payload: {
        reason: "output_budget_escalation",
        status: "entered",
        sequence: 1,
        family: "output_budget",
        attempt: null,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: "openai/gpt-5.4",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      turn: 0,
      payload: {
        reason: "provider_fallback_retry",
        status: "entered",
        sequence: 2,
        family: "recovery",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: "anthropic/claude",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_render_committed",
      turn: 0,
      payload: {
        turnId: "turn-2",
        attemptId: "attempt-3",
        status: "completed",
        assistantText: "recovered",
        toolOutputs: [],
      },
    });

    const frames = runtime.inspect.sessionWire.query(sessionId);
    expect(frames.map((frame) => frame.type)).toEqual([
      "turn.input",
      "turn.transition",
      "attempt.superseded",
      "attempt.started",
      "turn.transition",
      "attempt.superseded",
      "attempt.started",
      "turn.committed",
    ]);
    expect(frames[2]).toMatchObject({
      type: "attempt.superseded",
      attemptId: "attempt-1",
      supersededByAttemptId: "attempt-2",
      reason: "output_budget_escalation",
    });
    expect(frames[3]).toMatchObject({
      type: "attempt.started",
      attemptId: "attempt-2",
      reason: "output_budget_escalation",
    });
    expect(frames[5]).toMatchObject({
      type: "attempt.superseded",
      attemptId: "attempt-2",
      supersededByAttemptId: "attempt-3",
      reason: "provider_fallback_retry",
    });
    expect(frames[6]).toMatchObject({
      type: "attempt.started",
      attemptId: "attempt-3",
      reason: "provider_fallback_retry",
    });
    expect(frames[7]).toMatchObject({
      type: "turn.committed",
      attemptId: "attempt-3",
    });
  });

  test("projects approval, subagent, and session terminal receipts from durable tape", () => {
    const runtime = createRuntime();
    const sessionId = "session-wire-governance";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_input_recorded",
      turn: 0,
      payload: {
        turnId: "turn-3",
        trigger: "user",
        promptText: "delegate and approve",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "effect_commitment_approval_requested",
      turn: 0,
      payload: {
        requestId: "approval-1",
        toolName: "exec_command",
        toolCallId: "tool-approval-1",
        subject: "run command",
        argsSummary: "echo hello",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "effect_commitment_approval_decided",
      turn: 0,
      payload: {
        requestId: "approval-1",
        decision: "accept",
        actor: "operator",
        reason: "approved",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_spawned",
      turn: 0,
      payload: {
        runId: "run-1",
        delegate: "worker-1",
        kind: "patch",
        label: "Patch worker",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_completed",
      turn: 0,
      payload: {
        runId: "run-1",
        delegate: "worker-1",
        kind: "patch",
        summary: "updated files",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_shutdown",
      payload: {
        reason: "normal_exit",
      },
    });

    const frames = runtime.inspect.sessionWire.query(sessionId);
    expect(frames.map((frame) => frame.type)).toEqual([
      "turn.input",
      "approval.requested",
      "approval.decided",
      "subagent.started",
      "subagent.finished",
      "session.closed",
    ]);
    expect(frames[1]).toMatchObject({
      type: "approval.requested",
      requestId: "approval-1",
      toolName: "exec_command",
      toolCallId: "tool-approval-1",
      subject: "run command",
      detail: "echo hello",
    });
    expect(frames[3]).toMatchObject({
      type: "subagent.started",
      runId: "run-1",
      delegate: "worker-1",
      kind: "patch",
      lifecycle: "spawned",
    });
    expect(frames[4]).toMatchObject({
      type: "subagent.finished",
      runId: "run-1",
      status: "completed",
      summary: "updated files",
    });
    expect(frames[5]).toMatchObject({
      type: "session.closed",
      reason: "normal_exit",
    });
  });

  test("skips durable frames that cannot be mapped to a committed turn id", () => {
    const runtime = createRuntime();
    const sessionId = "session-wire-missing-turn";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      turn: 7,
      payload: {
        reason: "output_budget_escalation",
        status: "entered",
        sequence: 1,
        family: "output_budget",
        attempt: null,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: "openai/gpt-5.4",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "effect_commitment_approval_requested",
      turn: 7,
      payload: {
        requestId: "approval-2",
        toolName: "exec_command",
        toolCallId: "tool-approval-2",
        subject: "unmapped",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_input_recorded",
      turn: 0,
      payload: {
        turnId: "turn-4",
        trigger: "user",
        promptText: "mapped turn",
      },
    });

    const frames = runtime.inspect.sessionWire.query(sessionId);
    expect(frames.map((frame) => frame.type)).toEqual(["turn.input"]);
  });

  test("streams future durable frames through inspect.sessionWire.subscribe", () => {
    const runtime = createRuntime();
    const sessionId = "session-wire-subscribe";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_input_recorded",
      turn: 0,
      payload: {
        turnId: "turn-5",
        trigger: "user",
        promptText: "subscribe me",
      },
    });

    const observed: ReturnType<typeof runtime.inspect.sessionWire.query> = [];
    const unsubscribe = runtime.inspect.sessionWire.subscribe(sessionId, (frame) => {
      observed.push(frame);
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_render_committed",
      turn: 0,
      payload: {
        turnId: "turn-5",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "live committed",
        toolOutputs: [],
      },
    });
    unsubscribe();

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      type: "turn.committed",
      source: "live",
      durability: "durable",
      turnId: "turn-5",
      attemptId: "attempt-1",
    });
    expect(typeof observed[0]?.sourceEventId).toBe("string");
    expect(typeof observed[0]?.sourceEventType).toBe("string");
  });
});
