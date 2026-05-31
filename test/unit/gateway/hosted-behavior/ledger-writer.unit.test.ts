import { describe, expect, test } from "bun:test";
import { registerLedgerWriter } from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import { createMockExtensionApi, invokeHandler } from "../../../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("Hosted behavior gaps: ledger writer", () => {
  test("given error tool_result with mixed content, when ledger writer runs, then text is extracted and verdict is fail", () => {
    const { api, handlers } = createMockExtensionApi();

    const finished: any[] = [];
    const runtime = createRuntimeFixture({
      tools: {
        finish: (input: any) => {
          finished.push(input);
        },
      },
    });

    registerLedgerWriter(api, runtime);

    invokeHandler(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-err",
        toolName: "exec",
        input: { command: "false" },
        isError: true,
        content: [
          { type: "text", text: "line-a" },
          { type: "json", value: { ok: false } },
          { type: "text", text: "line-b" },
        ],
        details: { durationMs: 12 },
      },
      {
        sessionManager: {
          getSessionId: () => "lw-1",
        },
      },
    );

    expect(finished).toHaveLength(1);
    expect(finished[0].sessionId).toBe("lw-1");
    expect(finished[0].toolName).toBe("exec");
    expect(finished[0].channelSuccess).toBe(false);
    expect(finished[0].verdict).toBe("fail");
    expect(finished[0].outputText).toBe("line-a\nline-b");
    expect(finished[0].metadata.toolCallId).toBe("tc-err");
  });

  test("given failed tool_execution_end without tool_result, when ledger writer runs, then fallback failure result is recorded once", () => {
    const { api, handlers } = createMockExtensionApi();

    const finished: any[] = [];
    const runtime = createRuntimeFixture({
      tools: {
        finish: (input: any) => {
          finished.push(input);
        },
      },
    });

    registerLedgerWriter(api, runtime);

    const ctx = {
      sessionManager: {
        getSessionId: () => "lw-fallback-1",
      },
    };

    invokeHandler(
      handlers,
      "tool_execution_end",
      {
        toolCallId: "tc-fallback",
        toolName: "custom_commit_tool",
        isError: true,
      },
      ctx,
    );

    expect(finished).toHaveLength(1);
    expect(finished[0].sessionId).toBe("lw-fallback-1");
    expect(finished[0].toolCallId).toBe("tc-fallback");
    expect(finished[0].toolName).toBe("custom_commit_tool");
    expect(finished[0].channelSuccess).toBe(false);
    expect(finished[0].verdict).toBe("fail");
    expect(finished[0].args).toEqual({});
    expect(String(finished[0].outputText)).toContain("[ToolResultFallback]");
    expect(finished[0].metadata.lifecycleFallbackReason).toBe(
      "tool_execution_end_without_tool_result",
    );

    invokeHandler(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-fallback",
        toolName: "custom_commit_tool",
        input: { outputs: { ok: true } },
        isError: false,
        content: [{ type: "text", text: "done" }],
      },
      ctx,
    );

    expect(finished).toHaveLength(1);
  });

  test("given tool_execution_end with typed inconclusive outcome, when ledger writer runs, then verdict stays inconclusive", () => {
    const { api, handlers } = createMockExtensionApi();

    const finished: any[] = [];
    const runtime = createRuntimeFixture({
      tools: {
        finish: (input: any) => {
          finished.push(input);
        },
      },
    });

    registerLedgerWriter(api, runtime);

    invokeHandler(
      handlers,
      "tool_execution_end",
      {
        toolCallId: "tc-inconclusive",
        toolName: "poll",
        isError: false,
        result: {
          content: [{ type: "text", text: "still running" }],
          outcome: {
            kind: "inconclusive",
            reason: "process_running",
            value: { reason: "process_running", pid: 1234 },
          },
        },
      },
      {
        sessionManager: {
          getSessionId: () => "lw-inconclusive-1",
        },
      },
    );

    expect(finished).toHaveLength(1);
    expect(finished[0].channelSuccess).toBe(true);
    expect(finished[0].verdict).toBe("inconclusive");
    expect(finished[0].metadata.details).toEqual(
      expect.objectContaining({
        reason: "process_running",
        pid: 1234,
        sourceEvent: "tool_execution_end",
      }),
    );
  });

  test("given legacy tool_result details verdict, when ledger writer runs, then details do not override the verdict model", () => {
    const { api, handlers } = createMockExtensionApi();

    const finished: any[] = [];
    const runtime = createRuntimeFixture({
      tools: {
        finish: (input: any) => {
          finished.push(input);
        },
      },
    });

    registerLedgerWriter(api, runtime);

    invokeHandler(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-legacy-status",
        toolName: "process",
        input: { action: "poll", sessionId: "exec-1" },
        isError: false,
        content: [{ type: "text", text: "Process still running." }],
        details: { status: "running", sessionId: "exec-1", verdict: "fail" },
      },
      {
        sessionManager: {
          getSessionId: () => "lw-latest-only-1",
        },
      },
    );

    expect(finished).toHaveLength(1);
    expect(finished[0].channelSuccess).toBe(true);
    expect(finished[0].verdict).toBe("pass");
    expect(finished[0].metadata.details).toEqual({
      status: "running",
      sessionId: "exec-1",
      verdict: "fail",
    });
  });
});
