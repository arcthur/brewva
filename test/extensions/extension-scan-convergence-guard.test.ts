import { describe, expect, test } from "bun:test";
import {
  registerEventStream,
  registerQualityGate,
  registerScanConvergenceGuard,
} from "@brewva/brewva-extensions";
import { createMockExtensionAPI, invokeHandler, invokeHandlers } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function createContext(sessionId: string, cwd = "/tmp/brewva-scan-guard") {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

function markToolExecuted(
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >,
  ctx: Record<string, unknown>,
  toolCallId: string,
  toolName: string,
): void {
  invokeHandlers(handlers, "tool_execution_start", { toolCallId, toolName }, ctx);
}

describe("Extension gaps: scan convergence guard", () => {
  test("given repeated scan-only turns, when another scan tool is attempted, then guard blocks before quality gate side effects", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-turns-1";
    const { api, handlers } = createMockExtensionAPI();

    registerEventStream(api, runtime);
    registerScanConvergenceGuard(api, runtime);
    registerQualityGate(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      invokeHandlers(handlers, "turn_start", { turnIndex, timestamp: turnIndex }, ctx);
      invokeHandlers(
        handlers,
        "tool_call",
        {
          toolCallId: `tc-read-${turnIndex}`,
          toolName: "read",
          input: { file_path: `src/file-${turnIndex}.ts` },
        },
        ctx,
        { stopOnBlock: true },
      );
      markToolExecuted(handlers, ctx, `tc-read-${turnIndex}`, "read");
      invokeHandlers(
        handlers,
        "turn_end",
        {
          turnIndex,
          message: { role: "assistant", content: [] },
          toolResults: [],
        },
        ctx,
      );
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("scan_only_turns");

    const markedBeforeBlock = runtime.events.query(sessionId, { type: "tool_call_marked" }).length;

    invokeHandlers(handlers, "turn_start", { turnIndex: 4, timestamp: 4 }, ctx);
    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-blocked",
        toolName: "read",
        input: { file_path: "src/final.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_call_marked" })).toHaveLength(
      markedBeforeBlock,
    );

    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.reason).toBe("scan_only_turns");
    expect(runtime.events.query(sessionId, { type: "tool_call_blocked", last: 1 })).toHaveLength(1);

    invokeHandlers(
      handlers,
      "turn_end",
      {
        turnIndex: 4,
        message: { role: "assistant", content: [] },
        toolResults: [],
      },
      ctx,
    );

    const reset = runtime.events.query(sessionId, { type: "scan_convergence_reset", last: 1 })[0];
    expect(reset?.payload?.reason).toBe("turn_end_after_block");
  });

  test("given repeated out-of-bounds read failures, when another read is attempted, then guard blocks with scan failure reason", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-oob-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let index = 1; index <= 3; index += 1) {
      invokeHandlers(
        handlers,
        "tool_call",
        {
          toolCallId: `tc-read-oob-${index}`,
          toolName: "read",
          input: { file_path: "src/data.ts", offset: 1000 },
        },
        ctx,
        { stopOnBlock: true },
      );
      markToolExecuted(handlers, ctx, `tc-read-oob-${index}`, "read");
      invokeHandler(
        handlers,
        "tool_result",
        {
          toolCallId: `tc-read-oob-${index}`,
          toolName: "read",
          isError: true,
          content: [
            {
              type: "text",
              text: "Offset 1000 is beyond end of file (12 lines total)",
            },
          ],
        },
        ctx,
      );
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("scan_failures");

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-oob-blocked",
        toolName: "read",
        input: { file_path: "src/data.ts", offset: 1001 },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);
    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.reason).toBe("scan_failures");
  });

  test("given repeated grep ENOENT failures, when another grep is attempted, then guard blocks", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-grep-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let index = 1; index <= 3; index += 1) {
      invokeHandlers(
        handlers,
        "tool_call",
        {
          toolCallId: `tc-grep-${index}`,
          toolName: "grep",
          input: { pattern: "needle", path: `missing-${index}` },
        },
        ctx,
        { stopOnBlock: true },
      );
      markToolExecuted(handlers, ctx, `tc-grep-${index}`, "grep");
      invokeHandler(
        handlers,
        "tool_result",
        {
          toolCallId: `tc-grep-${index}`,
          toolName: "grep",
          isError: true,
          content: [
            {
              type: "text",
              text: "grep failed: ENOENT: no such file or directory, scandir 'missing-dir'",
            },
          ],
        },
        ctx,
      );
    }

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-grep-blocked",
        toolName: "grep",
        input: { pattern: "needle", path: "missing-dir" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);
    expect(
      runtime.events.query(sessionId, { type: "scan_convergence_blocked_tool", last: 1 }),
    ).toHaveLength(1);
  });

  test("given armed guard, when a non-scan tool changes strategy, then the guard resets and scan tools are allowed again", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-reset-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      invokeHandlers(handlers, "turn_start", { turnIndex, timestamp: turnIndex }, ctx);
      invokeHandlers(
        handlers,
        "tool_call",
        {
          toolCallId: `tc-read-reset-${turnIndex}`,
          toolName: "read",
          input: { file_path: `src/reset-${turnIndex}.ts` },
        },
        ctx,
        { stopOnBlock: true },
      );
      markToolExecuted(handlers, ctx, `tc-read-reset-${turnIndex}`, "read");
      invokeHandlers(
        handlers,
        "turn_end",
        {
          turnIndex,
          message: { role: "assistant", content: [] },
          toolResults: [],
        },
        ctx,
      );
    }

    const nonScan = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-task-set-spec",
        toolName: "task_set_spec",
        input: { goal: "summarize findings" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(nonScan.some((result) => (result as { block?: boolean })?.block === true)).toBe(false);
    markToolExecuted(handlers, ctx, "tc-task-set-spec", "task_set_spec");

    const reset = runtime.events.query(sessionId, { type: "scan_convergence_reset", last: 1 })[0];
    expect(reset?.payload?.reason).toBe("non_scan_tool");

    const readAfterReset = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-after-reset",
        toolName: "read",
        input: { file_path: "src/after-reset.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(readAfterReset.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      false,
    );
  });

  test("given armed guard, when a non-scan attempt is blocked later in the handler chain, then the guard remains armed", () => {
    const runtime = createRuntimeFixture({
      tools: {
        start: ({ toolName }: { toolName?: unknown }) =>
          toolName === "task_set_spec"
            ? { allowed: false, reason: "blocked-for-test" }
            : { allowed: true },
      },
    });
    const sessionId = "scan-guard-blocked-non-scan-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);
    registerQualityGate(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      invokeHandlers(handlers, "turn_start", { turnIndex, timestamp: turnIndex }, ctx);
      invokeHandlers(
        handlers,
        "tool_call",
        {
          toolCallId: `tc-read-armed-${turnIndex}`,
          toolName: "read",
          input: { file_path: `src/armed-${turnIndex}.ts` },
        },
        ctx,
        { stopOnBlock: true },
      );
      markToolExecuted(handlers, ctx, `tc-read-armed-${turnIndex}`, "read");
      invokeHandlers(
        handlers,
        "turn_end",
        {
          turnIndex,
          message: { role: "assistant", content: [] },
          toolResults: [],
        },
        ctx,
      );
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("scan_only_turns");

    invokeHandlers(handlers, "turn_start", { turnIndex: 4, timestamp: 4 }, ctx);

    const blockedNonScan = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-task-set-spec-blocked",
        toolName: "task_set_spec",
        input: { goal: "summarize findings" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blockedNonScan.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      true,
    );
    expect(runtime.events.query(sessionId, { type: "scan_convergence_reset" })).toHaveLength(0);

    const blockedRead = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-still-blocked",
        toolName: "read",
        input: { file_path: "src/still-blocked.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blockedRead.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      true,
    );
    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.reason).toBe("scan_only_turns");
  });

  test("given a new user input, when the previous session was armed, then the next scan starts fresh", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-input-reset-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let index = 1; index <= 3; index += 1) {
      invokeHandlers(
        handlers,
        "tool_call",
        {
          toolCallId: `tc-input-reset-${index}`,
          toolName: "read",
          input: { file_path: "src/input-reset.ts", offset: 1000 },
        },
        ctx,
        { stopOnBlock: true },
      );
      markToolExecuted(handlers, ctx, `tc-input-reset-${index}`, "read");
      invokeHandler(
        handlers,
        "tool_result",
        {
          toolCallId: `tc-input-reset-${index}`,
          toolName: "read",
          isError: true,
          content: [
            {
              type: "text",
              text: "Offset 1000 is beyond end of file (12 lines total)",
            },
          ],
        },
        ctx,
      );
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("scan_failures");

    invokeHandler(
      handlers,
      "input",
      {
        source: "user",
        text: "check a different file",
        images: [],
      },
      ctx,
    );

    const freshRead = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-input-reset-fresh",
        toolName: "read",
        input: { file_path: "src/fresh.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(freshRead.some((result) => (result as { block?: boolean })?.block === true)).toBe(false);
  });
});
