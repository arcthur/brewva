import { describe, expect, test } from "bun:test";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { createCliInspectPort } from "../../../packages/brewva-cli/src/runtime/cli-runtime-ports.js";
import { isSessionPhase } from "../../../packages/brewva-cli/src/shell/domain/session-phase.js";
import {
  createLiveSessionWireFrameStore,
  createSessionViewPort,
} from "../../../packages/brewva-cli/src/shell/ports/session-adapter.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/api.js";

function frame(sessionId: string, frameId: string): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId,
    source: "replay",
    durability: "durable",
    type: "turn.input",
    frameId,
    ts: 1_000,
    turnId: "turn-1",
    trigger: "user",
    promptText: "Hello",
  };
}

function durableReadFrames(sessionId: string): SessionWireFrame[] {
  return [
    {
      schema: SESSION_WIRE_SCHEMA,
      sessionId,
      source: "replay",
      durability: "durable",
      type: "turn.input",
      frameId: "frame:durable-input",
      ts: 1_000,
      turnId: "turn-1",
      trigger: "user",
      promptText: "Read the file",
    },
    {
      schema: SESSION_WIRE_SCHEMA,
      sessionId,
      source: "replay",
      durability: "durable",
      type: "tool.started",
      frameId: "frame:durable-tool-start",
      ts: 1_010,
      turnId: "turn-1",
      attemptId: "attempt-1",
      toolCallId: "tool-read-1",
      toolName: "read",
    },
    {
      schema: SESSION_WIRE_SCHEMA,
      sessionId,
      source: "replay",
      durability: "durable",
      type: "tool.finished",
      frameId: "frame:durable-tool-finish",
      ts: 1_020,
      turnId: "turn-1",
      attemptId: "attempt-1",
      toolCallId: "tool-read-1",
      toolName: "read",
      verdict: "pass",
      isError: false,
      text: "src/app.ts",
    },
  ] as SessionWireFrame[];
}

describe("SessionViewPort session wire cache", () => {
  test("reuses durable session wire on lightweight progress reads", () => {
    let queryCount = 0;
    const runtime = {
      ops: {
        sessionWire: {
          query(sessionId: string) {
            queryCount += 1;
            return [frame(sessionId, `frame:${queryCount}`)];
          },
        },
      },
    } as unknown as HostedRuntimeAdapterPort;
    const bundle = {
      session: {
        sessionManager: {
          getSessionId: () => "session-1",
        },
      },
      runtime,
      inspect: createCliInspectPort(runtime),
    };
    const port = createSessionViewPort(bundle as never);

    expect(port.getSessionWireFrames("session-1", { refreshDurable: true })[0]?.frameId).toBe(
      "frame:1",
    );
    expect(port.getSessionWireFrames("session-1", { refreshDurable: false })[0]?.frameId).toBe(
      "frame:1",
    );
    expect(queryCount).toBe(1);

    expect(port.getSessionWireFrames("session-1", { refreshDurable: true })[0]?.frameId).toBe(
      "frame:2",
    );
    expect(queryCount).toBe(2);

    expect(port.getSessionWireFrames("session-2", { refreshDurable: false })[0]?.frameId).toBe(
      "frame:3",
    );
    expect(queryCount).toBe(3);
  });

  test("keeps cockpit durable wire baseline available for lightweight progress snapshots", () => {
    let queryCount = 0;
    const runtime = {
      ops: {
        sessionWire: {
          query(sessionId: string) {
            queryCount += 1;
            return durableReadFrames(sessionId);
          },
        },
      },
    } as unknown as HostedRuntimeAdapterPort;
    const bundle = {
      session: {
        sessionManager: {
          getSessionId: () => "session-1",
        },
      },
      runtime,
      inspect: createCliInspectPort(runtime),
    };
    const port = createSessionViewPort(bundle as never);

    const coldSnapshot = port.getCockpitWireFoldSnapshot("session-1", {
      refreshDurable: true,
    });
    const progressSnapshot = port.getCockpitWireFoldSnapshot("session-1", {
      refreshDurable: false,
    });

    expect(coldSnapshot.toolCalls).toHaveLength(1);
    expect(coldSnapshot.toolCalls[0]).toMatchObject({
      toolCallId: "tool-read-1",
      status: "completed",
      text: "src/app.ts",
    });
    expect(coldSnapshot.transcriptMessages).toHaveLength(0);
    expect(progressSnapshot.toolCalls).toEqual(coldSnapshot.toolCalls);
    expect(queryCount).toBe(1);
  });

  test("preserves active turn anchors when high-volume live deltas overflow the cache", () => {
    const store = createLiveSessionWireFrameStore(5);
    store.remember(frame("session-1", "frame:input"));

    for (let index = 0; index < 12; index += 1) {
      store.remember({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: "session-1",
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        frameId: `frame:delta:${index}`,
        ts: 1_001 + index,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: String(index),
      });
    }

    const frames = [...store.values()];

    expect(frames).toHaveLength(5);
    expect(frames.some((candidate) => candidate.type === "turn.input")).toBe(true);
    expect(frames.at(-1)?.frameId).toBe("frame:delta:11");
  });

  test("returns the interactive projection to idle when a hosted prompt fails without a commit frame", async () => {
    const sessionId = "session-1";
    const session = {
      isStreaming: false,
      sessionManager: {
        getSessionId: () => sessionId,
      },
      async prompt() {},
      subscribe() {
        return () => {};
      },
      getQueuedPrompts() {
        return [];
      },
      removeQueuedPrompt() {
        return false;
      },
      async steer() {
        return { status: "no_active_run" };
      },
      async waitForIdle() {},
      async abort() {},
      getRegisteredTools() {
        return [];
      },
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: true };
          },
        };
      },
      createRuntimeToolContext() {
        return {
          getSystemPrompt() {
            return "";
          },
        };
      },
    };
    const turnRuntime = {
      identity: {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceRoot: "/repo",
      },
      config: {},
      tape: {
        list() {
          return [];
        },
      },
      kernel: {},
      model: {},
      async start() {
        return { recoveredSessions: [] };
      },
      async *turn() {
        yield {
          type: "tool.progress",
          progress: {
            toolCallId: "tool-exec-1",
            toolName: "exec",
            update: {
              outcome: { kind: "ok", value: {} },
              content: "started",
            },
          },
        };
        throw new Error("provider_tool_continuation_limit_exceeded");
      },
      async close() {},
    };
    const runtime = {
      identity: {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceRoot: "/repo",
      },
      config: {
        security: {
          actionAdmissionOverrides: {},
        },
      },
      ops: {
        sessionWire: {
          query() {
            return [];
          },
        },
      },
      runtime: turnRuntime,
      registerTurnSession() {},
    };
    const port = createSessionViewPort({
      session,
      runtime,
      toolDefinitions: new Map(),
      initPhases: [],
      phase: "ready",
    } as never);
    const phases: string[] = [];
    const unsubscribe = port.subscribe((event) => {
      if (event.type === "session_phase_change" && isSessionPhase(event.phase)) {
        phases.push(event.phase.kind);
      }
    });

    let thrown: unknown;
    try {
      await port.prompt([{ type: "text", text: "run diagnostics" }], { source: "interactive" });
    } catch (error) {
      thrown = error;
    } finally {
      unsubscribe();
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected_prompt_error");
    }
    expect(thrown.message).toContain("provider_tool_continuation_limit_exceeded");
    expect(phases).toContain("tool_executing");
    expect(phases.at(-1)).toBe("idle");
  });
});
