import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: structured replay events", () => {
  test("converts recorded events into structured replay stream", async () => {
    const workspace = createWorkspace("replay");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "replay-1";
    runtime.events.record({ sessionId, type: "session_start", payload: { cwd: workspace } });
    runtime.events.record({
      sessionId,
      type: "channel_session_bound",
      payload: { channel: "telegram", conversationId: "12345" },
    });
    runtime.events.record({ sessionId, type: "tool_call", turn: 1, payload: { toolName: "read" } });

    const structured = runtime.events.queryStructured(sessionId);
    expect(structured.length).toBe(3);
    expect(structured[0]?.schema).toBe("brewva.event.v1");
    expect(structured.map((event) => `${event.type}:${event.category}`)).toEqual(
      expect.arrayContaining([
        "session_start:session",
        "channel_session_bound:session",
        "tool_call:tool",
      ]),
    );

    const sessions = runtime.events.listReplaySessions();
    expect(sessions.map((entry) => entry.sessionId)).toContain(sessionId);
  });
});
