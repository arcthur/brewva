import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, createHostedRuntimePort } from "@brewva/brewva-runtime";
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = asBrewvaSessionId("replay-1");
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "channel_session_bound",
      payload: { channel: "telegram", conversationId: "12345" },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const olderSession = asBrewvaSessionId("session-older");
    const newerSession = asBrewvaSessionId("session-newer");

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId: newerSession,
      type: "session_start",
      payload: { cwd: workspace },
      timestamp: 3000,
    });

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId: olderSession,
      type: "session_start",
      payload: { cwd: workspace },
      timestamp: 1000,
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
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
});
