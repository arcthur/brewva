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
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { sleep } from "../../helpers/process.js";

type SessionNotification = Parameters<AcpGatewayConnection["sessionUpdate"]>[0];
type SessionWireFrameInput = SessionWireFrame extends infer Frame
  ? Frame extends SessionWireFrame
    ? Omit<Frame, "schema" | "sessionId" | "frameId" | "ts" | "source" | "durability"> & {
        readonly sessionId?: string;
      }
    : never
  : never;

let nextFrameId = 0;

function callString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sessionWireFrame(input: SessionWireFrameInput): SessionWireFrame {
  nextFrameId += 1;
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: "session-1",
    frameId: `frame-${nextFrameId}`,
    ts: nextFrameId,
    source: "live",
    durability: "cache",
    ...input,
  } as SessionWireFrame;
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
    let wireListener: ((frame: SessionWireFrame) => void) | undefined;
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
            wireListener?.(
              sessionWireFrame({
                type: "assistant.delta",
                turnId: "turn-1",
                attemptId: "attempt-1",
                lane: "answer",
                delta: "done",
              }),
            );
            wireListener?.(
              sessionWireFrame({
                type: "turn.committed",
                turnId: "turn-1",
                attemptId: "attempt-1",
                status: "completed",
                assistantText: "done",
                toolOutputs: [],
              }),
            );
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
    ]);
    expect("extNotification" in agent).toBe(false);
  });

  test("projects thinking and tool wire frames into ACP session updates", async () => {
    const updates: SessionNotification[] = [];
    let wireListener: ((frame: SessionWireFrame) => void) | undefined;
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
        async openSession() {
          return { requestedSessionId: "session-1" };
        },
        async subscribeSession() {},
        async sendPrompt() {
          void sleep(0).then(() => {
            wireListener?.(
              sessionWireFrame({
                type: "assistant.delta",
                turnId: "turn-1",
                attemptId: "attempt-1",
                lane: "thinking",
                delta: "Looking up context.",
              }),
            );
            wireListener?.(
              sessionWireFrame({
                type: "tool.started",
                turnId: "turn-1",
                attemptId: "attempt-1",
                toolCallId: "tool-1",
                toolName: "grep",
              }),
            );
            wireListener?.(
              sessionWireFrame({
                type: "tool.progress",
                turnId: "turn-1",
                attemptId: "attempt-1",
                toolCallId: "tool-1",
                toolName: "grep",
                verdict: "running",
                isError: false,
                text: "Scanning files.",
              }),
            );
            wireListener?.(
              sessionWireFrame({
                type: "tool.finished",
                turnId: "turn-1",
                attemptId: "attempt-1",
                toolCallId: "tool-1",
                toolName: "grep",
                verdict: "succeeded",
                isError: false,
                text: "Found 3 matches.",
              }),
            );
            wireListener?.(
              sessionWireFrame({
                type: "turn.committed",
                turnId: "turn-1",
                attemptId: "attempt-1",
                status: "completed",
                assistantText: "done",
                toolOutputs: [],
              }),
            );
          });
          return { accepted: true, turnId: "turn-1" };
        },
        async abortSession() {},
        async closeSession() {},
      },
    });

    const opened = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const result = await agent.prompt({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "Find references." }],
    });

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(updates.map((update) => update.update.sessionUpdate)).toEqual([
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
      "agent_message_chunk",
    ]);
    expect(updates[0]).toMatchObject({
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Looking up context." },
      },
    });
    expect(updates[1]).toMatchObject({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "grep",
        status: "pending",
      },
    });
    expect(updates[2]).toMatchObject({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "in_progress",
      },
    });
    expect(updates[3]).toMatchObject({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      },
    });
  });

  test("resolves prompts from terminal transition and session closed wire frames", async () => {
    const terminalFrames: Array<{
      readonly frame: SessionWireFrame;
      readonly stopReason: "cancelled" | "refusal";
    }> = [
      {
        frame: sessionWireFrame({
          type: "turn.transition",
          turnId: "turn-1",
          reason: "user_cancelled",
          status: "cancelled",
          family: "terminal",
        }),
        stopReason: "cancelled",
      },
      {
        frame: sessionWireFrame({
          type: "turn.transition",
          turnId: "turn-1",
          reason: "provider_failed",
          status: "failed",
          family: "terminal",
          error: "provider failed",
        }),
        stopReason: "refusal",
      },
      {
        frame: sessionWireFrame({
          type: "session.closed",
          reason: "client_closed",
        }),
        stopReason: "cancelled",
      },
    ];

    for (const { frame, stopReason } of terminalFrames) {
      let wireListener: ((wireFrame: SessionWireFrame) => void) | undefined;
      const agent = createAcpGatewayAgent({
        connection: {
          sessionUpdate: async () => undefined,
        },
        sessions: {
          onSessionWireFrame(listener) {
            wireListener = listener;
            return () => {
              wireListener = undefined;
            };
          },
          async openSession() {
            return { requestedSessionId: "session-1" };
          },
          async subscribeSession() {},
          async sendPrompt() {
            void sleep(0).then(() => wireListener?.(frame));
            return { accepted: true, turnId: "turn-1" };
          },
          async abortSession() {},
          async closeSession() {},
        },
        promptTimeoutMs: 100,
      });

      const opened = await agent.newSession({ cwd: "/repo", mcpServers: [] });
      const result = await agent.prompt({
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: "Run." }],
      });

      expect(result).toEqual({ stopReason });
    }
  });

  test("serializes ACP session updates in gateway wire order", async () => {
    const updateTexts: string[] = [];
    let releaseFirstUpdate: (() => void) | undefined;
    const firstUpdate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let wireListener: ((frame: SessionWireFrame) => void) | undefined;
    const agent = createAcpGatewayAgent({
      connection: {
        sessionUpdate: async (params: SessionNotification) => {
          const text =
            params.update.sessionUpdate === "agent_message_chunk" &&
            params.update.content.type === "text"
              ? params.update.content.text
              : "";
          updateTexts.push(text);
          if (text === "one") {
            await firstUpdate;
          }
        },
      },
      sessions: {
        onSessionWireFrame(listener) {
          wireListener = listener;
          return () => {
            wireListener = undefined;
          };
        },
        async openSession() {
          return { requestedSessionId: "session-1" };
        },
        async subscribeSession() {},
        async sendPrompt() {
          void sleep(0).then(() => {
            wireListener?.(
              sessionWireFrame({
                type: "assistant.delta",
                turnId: "turn-1",
                attemptId: "attempt-1",
                lane: "answer",
                delta: "one",
              }),
            );
            wireListener?.(
              sessionWireFrame({
                type: "assistant.delta",
                turnId: "turn-1",
                attemptId: "attempt-1",
                lane: "answer",
                delta: "two",
              }),
            );
            wireListener?.(
              sessionWireFrame({
                type: "turn.committed",
                turnId: "turn-1",
                attemptId: "attempt-1",
                status: "completed",
                assistantText: "one two",
                toolOutputs: [],
              }),
            );
          });
          return { accepted: true, turnId: "turn-1" };
        },
        async abortSession() {},
        async closeSession() {},
      },
      promptTimeoutMs: 1_000,
    });

    const opened = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const prompt = agent.prompt({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "Stream." }],
    });

    await sleep(0);
    await sleep(0);
    expect(updateTexts).toEqual(["one"]);

    releaseFirstUpdate?.();
    const result = await prompt;
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(updateTexts).toEqual(["one", "two"]);
  });

  test("aborts and closes sessions when the ACP connection shuts down", async () => {
    const shutdown = new AbortController();
    let disposeCount = 0;
    const calls: string[] = [];
    const agent = createAcpGatewayAgent({
      connection: {
        sessionUpdate: async () => undefined,
      },
      sessions: {
        onSessionWireFrame() {
          return () => {
            disposeCount += 1;
          };
        },
        async openSession() {
          calls.push("open");
          return { requestedSessionId: "session-1" };
        },
        async subscribeSession() {
          calls.push("subscribe");
        },
        async sendPrompt() {
          calls.push("send");
          return { accepted: true, turnId: "turn-1" };
        },
        async abortSession(input) {
          calls.push(`abort:${callString(input.sessionId ?? input.notification?.sessionId)}`);
        },
        async closeSession(input) {
          calls.push(`close:${callString(input.sessionId)}`);
        },
      },
      promptTimeoutMs: 1_000,
      shutdownSignal: shutdown.signal,
    });

    const opened = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const prompt = agent.prompt({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "Wait." }],
    });
    await sleep(0);

    shutdown.abort();
    let caught: unknown;
    try {
      await prompt;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : "").toContain("ACP connection closed");
    await sleep(0);

    expect(disposeCount).toBe(1);
    expect(calls).toEqual(["open", "subscribe", "send", "abort:session-1", "close:session-1"]);
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
    const observedFrame = sessionWireFrame({
      type: "assistant.delta",
      turnId: "turn-1",
      attemptId: "attempt-1",
      lane: "answer",
      delta: "ok",
    });

    await port.openSession({ cwd: " /repo ", managedToolMode: "direct" });
    await port.subscribeSession("session-1");
    await port.sendPrompt({
      sessionId: "session-1",
      request: { prompt: [{ type: "text", text: "Hello" }] },
    });
    listeners[0]?.({
      event: "session.wire.frame",
      payload: observedFrame,
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
    expect(frames).toEqual([observedFrame]);
  });
});
