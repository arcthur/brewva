import { describe, expect, test } from "bun:test";
import {
  createAcpGatewayAgent,
  createAcpGatewayClientSessionPort,
  type AcpGatewayConnection,
  toBrewvaSessionAbortParams,
  toBrewvaSessionOpenParams,
  toBrewvaSessionSendParams,
} from "@brewva/brewva-acp-adapter";
import { validateParamsForMethod } from "@brewva/brewva-gateway/protocol";
import { sleep } from "../../helpers/process.js";

type SessionNotification = Parameters<AcpGatewayConnection["sessionUpdate"]>[0];

function callString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

describe("ACP gateway adapter", () => {
  test("maps text-only ACP prompts into gateway session send params", () => {
    const params = toBrewvaSessionSendParams({
      sessionId: " session-1 ",
      turnId: " turn-1 ",
      request: {
        prompt: [
          { type: "text", text: "Summarize this change." },
          { type: "text", text: "Focus on protocol boundaries." },
        ],
      },
    });

    expect(params).toEqual({
      sessionId: "session-1",
      turnId: "turn-1",
      prompt: "Summarize this change.\n\nFocus on protocol boundaries.",
    });
    expect(validateParamsForMethod("sessions.send", params).ok).toBe(true);
  });

  test("rejects ACP prompt content the Brewva gateway cannot represent", () => {
    expect(() =>
      toBrewvaSessionSendParams({
        sessionId: "session-1",
        request: {
          prompt: [{ type: "image", data: "base64", mimeType: "image/png" }],
        },
      }),
    ).toThrow("unsupported ACP prompt block type: image");

    expect(() =>
      toBrewvaSessionSendParams({
        sessionId: "session-1",
        request: { prompt: [{ type: "text", text: "   " }] },
      }),
    ).toThrow("ACP prompt requires non-empty text content");
  });

  test("maps ACP session open inputs into gateway session open params", () => {
    const params = toBrewvaSessionOpenParams({
      sessionId: " session-1 ",
      cwd: " /repo ",
      model: "  ",
      agentId: " acp-agent ",
      managedToolMode: "hosted",
    });

    expect(params).toEqual({
      sessionId: "session-1",
      cwd: "/repo",
      agentId: "acp-agent",
      managedToolMode: "hosted",
    });
    expect(validateParamsForMethod("sessions.open", params).ok).toBe(true);
  });

  test("omits unsupported ACP cancel reasons from gateway abort params", () => {
    const params = toBrewvaSessionAbortParams({
      sessionId: "session-1",
      reason: "not-a-gateway-reason",
    });

    expect(params).toEqual({ sessionId: "session-1" });
    expect(validateParamsForMethod("sessions.abort", params).ok).toBe(true);
  });

  test("adapts ACP agent calls to the gateway session port and streams gateway frames back", async () => {
    const updates: SessionNotification[] = [];
    let wireListener:
      | ((frame: {
          sessionId: string;
          type: string;
          turnId?: string;
          attemptId?: string;
          lane?: string;
          delta?: string;
          status?: string;
          assistantText?: string;
          toolOutputs?: unknown[];
        }) => void)
      | undefined;
    const calls: string[] = [];
    const agent = createAcpGatewayAgent({
      connection: {
        sessionUpdate: async (params: SessionNotification) => {
          updates.push(params);
        },
      },
      sessions: {
        onSessionWireFrame(listener) {
          wireListener = listener;
          return () => {
            wireListener = undefined;
          };
        },
        async openSession(input) {
          calls.push(`open:${callString(input.cwd)}`);
          return { requestedSessionId: "session-1" };
        },
        async subscribeSession(sessionId) {
          calls.push(`subscribe:${sessionId}`);
        },
        async sendPrompt(input) {
          calls.push(`send:${callString(input.sessionId ?? input.request.sessionId)}`);
          void sleep(0).then(() => {
            wireListener?.({
              sessionId: "session-1",
              type: "assistant.delta",
              turnId: "turn-1",
              attemptId: "attempt-1",
              lane: "answer",
              delta: "done",
            });
            wireListener?.({
              sessionId: "session-1",
              type: "turn.committed",
              turnId: "turn-1",
              attemptId: "attempt-1",
              status: "completed",
              assistantText: "done",
              toolOutputs: [],
            });
          });
          return { accepted: true, turnId: "turn-1" };
        },
        async abortSession(input) {
          calls.push(`abort:${callString(input.sessionId ?? input.notification?.sessionId)}`);
        },
        async closeSession(input) {
          calls.push(`close:${callString(input.sessionId)}`);
        },
      },
    });

    const initialized = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const opened = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const result = await agent.prompt({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "Run checks." }],
    });
    await agent.cancel({ sessionId: opened.sessionId });
    await agent.extNotification?.("brewva/session/close", { sessionId: opened.sessionId });

    expect(initialized.agentInfo?.name).toBe("Brewva");
    expect(opened).toEqual({ sessionId: "session-1" });
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(updates).toEqual([
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      },
    ]);
    expect(calls).toEqual([
      "open:/repo",
      "subscribe:session-1",
      "send:session-1",
      "abort:session-1",
      "close:session-1",
    ]);
  });

  test("uses the gateway client request API instead of constructing duplicate raw frames", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
    const port = createAcpGatewayClientSessionPort({
      async request(method, params) {
        calls.push({ method, params });
        if (method === "sessions.open") return { requestedSessionId: "session-1" };
        if (method === "sessions.send") return { accepted: true, turnId: "turn-1" };
        return {};
      },
      onEvent(listener) {
        listeners.push(listener);
        return () => undefined;
      },
    });
    const frames: unknown[] = [];
    port.onSessionWireFrame((frame) => frames.push(frame));

    await port.openSession({ cwd: " /repo ", managedToolMode: "direct" });
    await port.subscribeSession("session-1");
    await port.sendPrompt({
      sessionId: "session-1",
      request: { prompt: [{ type: "text", text: "Hello" }] },
    });
    listeners[0]?.({
      event: "session.wire.frame",
      payload: {
        sessionId: "session-1",
        type: "assistant.delta",
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "ok",
      },
    });

    expect(calls).toEqual([
      {
        method: "sessions.open",
        params: { cwd: "/repo", managedToolMode: "direct" },
      },
      { method: "sessions.subscribe", params: { sessionId: "session-1" } },
      {
        method: "sessions.send",
        params: { sessionId: "session-1", prompt: "Hello" },
      },
    ]);
    expect(frames).toEqual([
      {
        sessionId: "session-1",
        type: "assistant.delta",
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "ok",
      },
    ]);
  });
});
