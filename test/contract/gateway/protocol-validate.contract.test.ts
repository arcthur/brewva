import { describe, expect, test } from "bun:test";
import {
  validateParamsForMethod,
  validateRequestFrame,
  validateSessionWireFramePayload,
} from "@brewva/brewva-gateway";

describe("gateway protocol validator", () => {
  test("given connect params with auth token and challenge nonce, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("connect", {
      protocol: 1,
      client: {
        id: "client-1",
        version: "0.1.0",
      },
      auth: {
        token: "token-1",
      },
      challengeNonce: "nonce-1",
    });
    expect(result.ok).toBe(true);
  });

  test("given connect params without auth token and challenge nonce, when validating params, then validation fails", () => {
    const result = validateParamsForMethod("connect", {
      protocol: 1,
      client: {
        id: "client-1",
        version: "0.1.0",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("required property");
  });

  test("given valid sessions.close params, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("sessions.close", {
      sessionId: "session-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.sessionId).toBe("session-1");
  });

  test("given sessions.close without sessionId, when validating params, then validation fails", () => {
    const result = validateParamsForMethod("sessions.close", {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("required property");
  });

  test("given sessions.close with extra property, when validating params, then validation fails", () => {
    const result = validateParamsForMethod("sessions.close", {
      sessionId: "session-1",
      extra: "not-allowed",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("unexpected property 'extra'");
  });

  test("given valid sessions.subscribe params, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("sessions.subscribe", {
      sessionId: "session-2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.sessionId).toBe("session-2");
  });

  test("given sessions.abort with user_submit reason, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("sessions.abort", {
      sessionId: "session-2",
      reason: "user_submit",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.reason).toBe("user_submit");
  });

  test("given sessions.send with turnId, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("sessions.send", {
      sessionId: "session-3",
      prompt: "hello",
      turnId: "turn-3",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.turnId).toBe("turn-3");
  });

  test("given sessions.open with optional agent and managed-tool mode, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("sessions.open", {
      sessionId: "session-5",
      cwd: "/tmp/workspace",
      configPath: ".brewva/brewva.json",
      model: "openai/gpt-5",
      agentId: "code-reviewer",
      managedToolMode: "hosted",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.agentId).toBe("code-reviewer");
    expect(result.params.managedToolMode).toBe("hosted");
  });

  test("given sessions.unsubscribe with extra property, when validating params, then validation fails", () => {
    const result = validateParamsForMethod("sessions.unsubscribe", {
      sessionId: "session-4",
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("unexpected property 'extra'");
  });

  test("given request frame with non-empty traceId, when validating frame, then frame is accepted", () => {
    const ok = validateRequestFrame({
      type: "req",
      id: "req-1",
      traceId: "trace-1",
      method: "health",
      params: {},
    });
    expect(ok).toBe(true);
  });

  test("given request frame with empty traceId, when validating frame, then frame is rejected", () => {
    const ok = validateRequestFrame({
      type: "req",
      id: "req-2",
      traceId: "",
      method: "health",
      params: {},
    });
    expect(ok).toBe(false);
  });

  test("given gateway.rotate-token with empty params, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("gateway.rotate-token", {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params).toEqual({});
  });

  test("given gateway.rotate-token with unsupported params, when validating params, then validation fails", () => {
    const result = validateParamsForMethod("gateway.rotate-token", {
      graceMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("unexpected property 'graceMs'");
  });

  test("given session wire v2 tool frame with attemptId, when validating payload, then validation succeeds", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "live:tool-started",
      ts: 1,
      source: "live",
      durability: "cache",
      type: "tool.started",
      turnId: "turn-1",
      attemptId: "attempt-2",
      toolCallId: "tool-call-1",
      toolName: "exec",
    });
    expect(result.ok).toBe(true);
  });

  test("given session wire tool frame with display payload, when validating payload, then validation succeeds", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "live:tool-finished",
      ts: 1,
      source: "live",
      durability: "cache",
      type: "tool.finished",
      turnId: "turn-1",
      attemptId: "attempt-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
      verdict: "pass",
      isError: false,
      text: "ok",
      display: {
        summaryText: "exec ok",
        detailsText: "ok",
        rawText: "ok",
      },
    });
    expect(result.ok).toBe(true);
  });

  test("given open vocabulary turn transition strings, when validating payload, then validation succeeds", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "event:turn-transition-cancelled",
      ts: 1,
      source: "replay",
      durability: "durable",
      sourceEventId: "event-1",
      sourceEventType: "runtime.transition",
      type: "turn.transition",
      turnId: "turn-1",
      reason: "operator_cancelled",
      status: "cancelled",
      family: "operator",
      attemptId: "attempt-1",
    });
    expect(result.ok).toBe(true);
  });

  test("given open vocabulary turn input trigger, when validating payload, then validation succeeds", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "event:turn-input-trigger",
      ts: 1,
      source: "replay",
      durability: "durable",
      sourceEventId: "event-1",
      sourceEventType: "turn.input.recorded",
      type: "turn.input",
      turnId: "turn-1",
      promptText: "Continue",
      trigger: "operator_retry",
    });
    expect(result.ok).toBe(true);
  });

  test("given open vocabulary tool verdict, when validating payload, then validation succeeds", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "live:tool-progress-custom-verdict",
      ts: 1,
      source: "live",
      durability: "cache",
      type: "tool.progress",
      turnId: "turn-1",
      attemptId: "attempt-1",
      toolCallId: "tool-call-1",
      toolName: "verify",
      verdict: "deferred",
      isError: false,
      text: "waiting for external check",
    });
    expect(result.ok).toBe(true);
  });

  test("given session wire tool frame without attemptId, when validating payload, then validation fails", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "live:tool-started",
      ts: 1,
      source: "live",
      durability: "cache",
      type: "tool.started",
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("tool.started");
  });

  test("given approval decided frame with request-local decision, when validating payload, then validation succeeds", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "live:approval-decided",
      ts: 1,
      source: "live",
      durability: "durable",
      sourceEventId: "evt-approval-decided",
      sourceEventType: "approval.decided",
      type: "approval.decided",
      turnId: "turn-1",
      requestId: "approval-session-turn-tool",
      decision: "deny",
      actor: "operator",
      reason: "not required",
    });
    expect(result.ok).toBe(true);
  });

  test("given approval decided frame with legacy decision, when validating payload, then validation fails", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "live:approval-decided",
      ts: 1,
      source: "live",
      durability: "durable",
      sourceEventId: "evt-approval-decided",
      sourceEventType: "approval.decided",
      type: "approval.decided",
      turnId: "turn-1",
      requestId: "approval-session-turn-tool",
      decision: "approved",
      actor: "operator",
    });
    expect(result.ok).toBe(false);
  });

  test("given durable replay frame without provenance, when validating payload, then validation fails", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "replay:turn-committed",
      ts: 1,
      source: "replay",
      durability: "durable",
      type: "turn.committed",
      turnId: "turn-1",
      attemptId: "attempt-1",
      status: "completed",
      assistantText: "done",
      toolOutputs: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("sourceEventId");
  });

  test("given cache status frame with provenance, when validating payload, then validation fails", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "live:status",
      ts: 1,
      source: "live",
      durability: "cache",
      sourceEventId: "evt-1",
      sourceEventType: "turn_render_committed",
      type: "session.status",
      state: "running",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("must not carry source provenance");
  });

  test("given replay tool preview frame, when validating payload, then validation fails", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "replay:tool-started",
      ts: 1,
      source: "replay",
      durability: "cache",
      type: "tool.started",
      turnId: "turn-1",
      attemptId: "attempt-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("live cache frame");
  });

  test("given subagent session wire frame, when validating payload, then validation fails", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "live:subagent-started",
      ts: 1,
      source: "live",
      durability: "durable",
      sourceEventId: "evt-subagent-1",
      sourceEventType: "subagent_spawned",
      type: "subagent.started",
      turnId: "turn-1",
      runId: "run-1",
      delegate: "navigator",
      kind: "evidence",
      lifecycle: "spawned",
      label: "Inspect replay",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("unsupported session wire frame type");
  });

  test("given invalid assistant segments on committed turn, when validating payload, then validation fails", () => {
    const result = validateSessionWireFramePayload({
      schema: "brewva.session-wire.v2",
      sessionId: "session-1",
      frameId: "replay:turn-1:committed",
      ts: 1,
      source: "replay",
      durability: "durable",
      sourceEventId: "evt-turn-ended",
      sourceEventType: "turn.ended",
      type: "turn.committed",
      turnId: "turn-1",
      attemptId: "runtime-turn",
      status: "completed",
      assistantText: "done",
      assistantSegments: [{ text: 123, ts: "bad" }],
      toolOutputs: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("turn.committed payload is invalid");
  });
});
