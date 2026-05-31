import { describe, expect, test } from "bun:test";
import { registerEventStream } from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import { invokeHandler, createMockExtensionApi } from "../../../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function createSessionContext(sessionId: string) {
  return {
    cwd: "/tmp/repo",
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
    },
  };
}

describe("hosted event stream", () => {
  test("settles active tool executions at agent_end without duplicating shutdown receipts", () => {
    const { api, handlers } = createMockExtensionApi();
    const runtime = createRuntimeFixture();
    const sessionId = "event-stream-agent-end-settlement";
    const ctx = createSessionContext(sessionId);

    registerEventStream(api, runtime);

    invokeHandler(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "call-orphaned",
        toolName: "exec",
        args: { command: "sleep 1" },
      },
      ctx,
    );
    invokeHandler(handlers, "agent_end", { messages: [] }, ctx);
    invokeHandler(handlers, "session_shutdown", {}, ctx);

    const ended = runtime.ops.events.records.query(sessionId, {
      type: "tool_execution_ended",
    });

    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toMatchObject({
      toolCallId: "call-orphaned",
      toolName: "exec",
      isError: true,
      terminalReason: "failed",
      lifecycleFallbackReason: "agent_end_without_tool_execution_end",
    });
  });
});
