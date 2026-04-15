import { describe, expect, test } from "bun:test";
import { registerQualityGate } from "@brewva/brewva-gateway/runtime-plugins";
import { createGrepTool, createScheduleIntentTool } from "@brewva/brewva-tools";
import { createMockRuntimePluginApi, invokeHandler } from "../../helpers/runtime-plugin.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("Runtime plugin gaps: quality gate", () => {
  test("given sanitizer output differs, when input hook runs, then runtime plugin returns transform action", () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const userInputs: string[] = [];

    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
        onUserInput: (sessionId: string) => {
          userInputs.push(sessionId);
        },
        sanitizeInput: (text: string) => `sanitized:${text}`,
      },
    });

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ action: string; parts?: Array<Record<string, unknown>> }>(
      handlers,
      "input",
      {
        source: "user",
        text: "hello",
        parts: [
          { type: "text", text: "hello" },
          { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
        ],
      },
      { sessionManager: { getSessionId: () => "quality-input-1" } },
    );

    expect(result.action).toBe("transform");
    expect(result.parts).toEqual([
      { type: "text", text: "sanitized:hello" },
      { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
    ]);
    expect(userInputs).toEqual(["quality-input-1"]);
  });

  test("given sanitizer output unchanged, when input hook runs, then runtime plugin returns continue action", () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const userInputs: string[] = [];

    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
        onUserInput: (sessionId: string) => {
          userInputs.push(sessionId);
        },
        sanitizeInput: (text: string) => text,
      },
    });

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ action: string }>(
      handlers,
      "input",
      {
        source: "user",
        text: "hello",
        parts: [{ type: "text", text: "hello" }],
      },
      { sessionManager: { getSessionId: () => "quality-input-2" } },
    );

    expect(result.action).toBe("continue");
    expect(userInputs).toEqual(["quality-input-2"]);
  });

  test("given non-ascii input unchanged by sanitizer, when input hook runs, then runtime plugin continues", () => {
    const { api, handlers, sentMessages } = createMockRuntimePluginApi();
    const userInputs: string[] = [];

    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
        onUserInput: (sessionId: string) => {
          userInputs.push(sessionId);
        },
        sanitizeInput: (text: string) => text,
      },
    });

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ action: string }>(
      handlers,
      "input",
      {
        source: "interactive",
        text: "请 review this change",
        parts: [{ type: "text", text: "请 review this change" }],
      },
      { sessionManager: { getSessionId: () => "quality-input-3" } },
    );

    expect(result.action).toBe("continue");
    expect(sentMessages).toHaveLength(0);
    expect(userInputs).toEqual(["quality-input-3"]);
  });

  test("given tool_call and context usage, when quality gate runs, then runtime.authority.tools.start receives normalized usage", () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const calls: any[] = [];
    const runtime = createRuntimeFixture({
      tools: {
        start: (input: any) => {
          calls.push(input);
          return { allowed: true };
        },
      },
      context: {
        sanitizeInput: (text: string) => text,
      },
    });

    registerQualityGate(api, runtime);

    const result = invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-quality",
        toolName: "exec",
        input: { command: "echo hi" },
      },
      {
        sessionManager: { getSessionId: () => "qg-1" },
        getContextUsage: () => ({ tokens: 123, contextWindow: 4096, percent: 0.03 }),
      },
    );

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe("qg-1");
    expect(calls[0].toolCallId).toBe("tc-quality");
    expect(calls[0].toolName).toBe("exec");
    expect(calls[0].args).toEqual({ command: "echo hi" });
    expect(calls[0].usage.tokens).toBe(123);
    expect(calls[0].usage.contextWindow).toBe(4096);
  });

  test("given runtime.authority.tools.start denial, when tool_call hook runs, then runtime plugin blocks call with reason", () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({
          allowed: false,
          reason: "blocked-by-runtime",
        }),
      },
      context: {
        sanitizeInput: (text: string) => text,
      },
    });

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ block?: boolean; reason?: string }>(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-block",
        toolName: "exec",
        input: { command: "false" },
      },
      {
        sessionManager: { getSessionId: () => "qg-2" },
        getContextUsage: () => ({ tokens: 980, contextWindow: 1000, percent: 0.98 }),
      },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toBe("blocked-by-runtime");
  });

  test("given allowed tool_call with advisory, when tool_result hook runs, then advisory is injected into the same turn", () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({
          allowed: true,
          advisory:
            "[ExplorationAdvisory]\nSummarize what you know, then switch strategy before broadening the scan.",
        }),
      },
      context: {
        sanitizeInput: (text: string) => text,
      },
    });

    registerQualityGate(api, runtime);

    invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-advisory",
        toolName: "look_at",
        input: { goal: "inspect runtime" },
      },
      {
        sessionManager: { getSessionId: () => "qg-3" },
        getContextUsage: () => ({ tokens: 120, contextWindow: 4096, percent: 0.03 }),
      },
    );

    const result = invokeHandler<{ content?: Array<{ text?: string }> }>(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-advisory",
        toolName: "look_at",
        input: { goal: "inspect runtime" },
        isError: false,
        content: [{ type: "text", text: "original result" }],
      },
      {
        sessionManager: { getSessionId: () => "qg-3" },
      },
    );

    expect(result.content?.[0]?.text).toContain("[ExplorationAdvisory]");
    expect(result.content?.[1]?.text).toBe("original result");
  });

  test("given invocation validation failure, when tool_result hook runs, then repair hint includes canonical enum contract", () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
        sanitizeInput: (text: string) => text,
      },
    });
    const grepTool = createGrepTool({ runtime });

    registerQualityGate(api, runtime, {
      toolDefinitionsByName: new Map([[grepTool.name, grepTool]]),
    });

    invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-repair",
        toolName: "grep",
        input: { query: "needle", case: "loud" },
      },
      {
        sessionManager: { getSessionId: () => "qg-4" },
        getContextUsage: () => ({ tokens: 64, contextWindow: 4096, percent: 0.02 }),
      },
    );

    const result = invokeHandler<{ content?: Array<{ text?: string }> }>(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-repair",
        toolName: "grep",
        input: { query: "needle", case: "loud" },
        isError: true,
        content: [
          { type: "text", text: "Schema validation failed: case must be equal to constant" },
        ],
        details: { message: "Schema validation failed" },
      },
      {
        sessionManager: { getSessionId: () => "qg-4" },
      },
    );

    expect(result.content?.[0]?.text).toContain("[InvocationRepair]");
    expect(result.content?.[0]?.text).toContain('case: got="loud"');
    expect(result.content?.[0]?.text).toContain("accepted=smart|insensitive|sensitive");
    expect(result.content?.[0]?.text).toContain("recommended=smart");
  });

  test("given nested invocation validation failure, when tool_result hook runs, then repair hint includes nested parameter path", () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
        sanitizeInput: (text: string) => text,
      },
    });
    const scheduleIntentTool = createScheduleIntentTool({ runtime });

    registerQualityGate(api, runtime, {
      toolDefinitionsByName: new Map([[scheduleIntentTool.name, scheduleIntentTool]]),
    });

    invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-schedule-repair",
        toolName: "schedule_intent",
        input: {
          action: "create",
          reason: "wait for state",
          delayMs: 120_000,
          convergenceCondition: {
            kind: "phase_gate",
            phase: "complete",
          },
        },
      },
      {
        sessionManager: { getSessionId: () => "qg-5" },
        getContextUsage: () => ({ tokens: 96, contextWindow: 4096, percent: 0.02 }),
      },
    );

    const result = invokeHandler<{ content?: Array<{ text?: string }> }>(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-schedule-repair",
        toolName: "schedule_intent",
        input: {
          action: "create",
          reason: "wait for state",
          delayMs: 120_000,
          convergenceCondition: {
            kind: "phase_gate",
            phase: "complete",
          },
        },
        isError: true,
        content: [
          {
            type: "text",
            text: "Schema validation failed: convergenceCondition.kind must be equal to constant",
          },
        ],
        details: { message: "Schema validation failed" },
      },
      {
        sessionManager: { getSessionId: () => "qg-5" },
      },
    );

    expect(result.content?.[0]?.text).toContain("[InvocationRepair]");
    expect(result.content?.[0]?.text).toContain('convergenceCondition.kind: got="phase_gate"');
    expect(result.content?.[0]?.text).toContain(
      "accepted=truth_resolved|task_phase|max_runs|all_of|any_of",
    );
    expect(result.content?.[0]?.text).toContain('convergenceCondition.phase: got="complete"');
  });
});
