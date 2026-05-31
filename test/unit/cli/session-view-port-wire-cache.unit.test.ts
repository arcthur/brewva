import { describe, expect, test } from "bun:test";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import {
  createLiveSessionWireFrameStore,
  createSessionViewPort,
} from "../../../packages/brewva-cli/src/shell/ports/session-adapter.js";

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
    const bundle = {
      session: {
        sessionManager: {
          getSessionId: () => "session-1",
        },
      },
      runtime: {
        ops: {
          sessionWire: {
            query(sessionId: string) {
              queryCount += 1;
              return [frame(sessionId, `frame:${queryCount}`)];
            },
          },
        },
      },
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
    const bundle = {
      session: {
        sessionManager: {
          getSessionId: () => "session-1",
        },
      },
      runtime: {
        ops: {
          sessionWire: {
            query(sessionId: string) {
              queryCount += 1;
              return durableReadFrames(sessionId);
            },
          },
        },
      },
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
});
