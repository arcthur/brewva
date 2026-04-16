import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, asBrewvaSessionId } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
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
    const sessionId = asBrewvaSessionId("replay-1");
    recordRuntimeEvent(runtime, { sessionId, type: "session_start", payload: { cwd: workspace } });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "channel_session_bound",
      payload: { channel: "telegram", conversationId: "12345" },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_call",
      turn: 1,
      payload: { toolName: "read" },
    });

    const structured = runtime.inspect.events.queryStructured(sessionId);
    expect(structured.length).toBe(3);
    expect(structured[0]?.schema).toBe("brewva.event.v1");
    expect(structured.map((event) => `${event.type}:${event.category}`)).toEqual(
      expect.arrayContaining([
        "session_start:session",
        "channel_session_bound:session",
        "tool_call:tool",
      ]),
    );

    const sessions = runtime.inspect.events.listReplaySessions();
    expect(sessions.map((entry) => entry.sessionId)).toContain(sessionId);
  });
});
