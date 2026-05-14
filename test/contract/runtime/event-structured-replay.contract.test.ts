import { describe, expect, test } from "bun:test";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("structured event replay", () => {
  test("converts recorded events into structured replay stream", async () => {
    const workspace = createWorkspace("replay");
    writeConfig(workspace, createConfig({}));

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const sessionId = asBrewvaSessionId("replay-1");
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "channel_session_bound",
      payload: { channel: "telegram", conversationId: "12345" },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "tool_call",
      turn: 1,
      payload: { toolCallId: "tc-read-1", toolName: "read" },
    });

    const structured = runtime.inspect.events.records.queryStructured(sessionId);
    expect(structured.length).toBe(3);
    expect(structured[0]?.schema).toBe("brewva.event.v1");
    expect(structured.map((event) => `${event.type}:${event.category}`)).toEqual(
      expect.arrayContaining([
        "session_start:session",
        "channel_session_bound:session",
        "tool_call:tool",
      ]),
    );

    const sessions = runtime.inspect.events.log.listReplaySessions();
    expect(sessions.map((entry) => entry.sessionId)).toContain(sessionId);
  });

  test("listReplaySessions orders rows by last event timestamp, not jsonl directory order", async () => {
    const workspace = createWorkspace("replay-order");
    writeConfig(workspace, createConfig({}));

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const olderSession = asBrewvaSessionId("session-older");
    const newerSession = asBrewvaSessionId("session-newer");

    runtime.extensions.hosted.events.record({
      sessionId: newerSession,
      type: "session_start",
      payload: { cwd: workspace },
      timestamp: 3000,
    });

    runtime.extensions.hosted.events.record({
      sessionId: olderSession,
      type: "session_start",
      payload: { cwd: workspace },
      timestamp: 1000,
    });
    runtime.extensions.hosted.events.record({
      sessionId: olderSession,
      type: "channel_session_bound",
      payload: { channel: "cli", conversationId: "x" },
      timestamp: 2000,
    });

    expect(runtime.inspect.events.log.listReplaySessions()).toEqual([
      expect.objectContaining({ sessionId: newerSession, lastEventAt: 3000 }),
      expect.objectContaining({ sessionId: olderSession, lastEventAt: 2000 }),
    ]);
  });

  test("listReplaySessions projects generated titles", async () => {
    const workspace = createWorkspace("replay-title");
    writeConfig(workspace, createConfig({}));

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const sessionId = asBrewvaSessionId("session-title");

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
      timestamp: 1000,
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "turn_input_recorded",
      turn: 1,
      payload: { turnId: "turn-1", trigger: "user", promptText: "Build session titles" },
      timestamp: 2000,
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_title_recorded",
      payload: {
        title: "Session Overlay Titles",
        source: "llm",
        turnId: "turn-1",
        promptEventId: "prompt-event-1",
        model: { provider: "openai", id: "gpt-5.4-mini", api: "openai" },
        generatedAt: 7000,
      },
      timestamp: 3000,
    });

    expect(runtime.inspect.events.log.listReplaySessions()).toEqual([
      expect.objectContaining({
        sessionId,
        title: "Session Overlay Titles",
      }),
    ]);
  });

  test("listReplaySessions ignores malformed generated title payloads", async () => {
    const workspace = createWorkspace("replay-title-malformed");
    writeConfig(workspace, createConfig({}));

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: RUNTIME_CONTRACT_CONFIG_PATH,
    }).hosted;
    const sessionId = asBrewvaSessionId("session-title-malformed");

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
      timestamp: 1000,
    });
    expect(() =>
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "session_title_recorded",
        payload: {
          title: "Incomplete Title Fact",
          source: "llm",
          turnId: "turn-1",
          promptEventId: "prompt-event-1",
          generatedAt: 7000,
        },
        timestamp: 3000,
      }),
    ).toThrow("invalid_recorded_event_payload:session_title_recorded");

    expect(runtime.inspect.events.log.listReplaySessions()).toEqual([
      expect.objectContaining({
        sessionId,
        title: "New session",
      }),
    ]);
  });
});
