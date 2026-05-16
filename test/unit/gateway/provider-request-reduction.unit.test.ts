import { describe, expect, test } from "bun:test";
import { recordSessionTurnTransition } from "@brewva/brewva-gateway";
import type { TransientReductionState } from "@brewva/brewva-runtime/context";
import { readContextEvidenceRecords } from "../../../packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.js";
import {
  registerProviderRequestRecovery,
  registerProviderRequestReduction,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import { armNextPromptOutputBudgetEscalation } from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/recovery/output-budget-state.js";
import { createMockExtensionApi, type ExtensionTestHandler } from "../../helpers/extension.js";
import { createRuntimeConfig, createRuntimeFixture } from "../../helpers/runtime.js";

const CLEARED_TOOL_RESULT_PLACEHOLDER = "[cleared_for_request]";
const MIN_CLEARABLE_TOOL_RESULT_CHARS = 512;
const LARGE_TOOL_RESULT = "x".repeat(MIN_CLEARABLE_TOOL_RESULT_CHARS);

function recordMessageEnd(input: {
  runtime: ReturnType<typeof createRuntimeFixture>;
  sessionId: string;
  timestamp?: number;
}): void {
  input.runtime.extensions.hosted.events.record({
    sessionId: input.sessionId,
    type: "message_end",
    turn: 0,
    timestamp: input.timestamp ?? Date.now(),
    payload: { messageId: "assistant-cache-clock" },
  });
}

function readTransientReduction(
  runtime: ReturnType<typeof createRuntimeFixture>,
  sessionId: string,
): TransientReductionState | undefined {
  const sample = runtime.inspect.context.evidence.latest(sessionId, "transient_reduction");
  return sample
    ? ({
        turn: sample.turn,
        updatedAt: sample.timestamp,
        ...sample.payload,
      } as TransientReductionState)
    : undefined;
}

function createReductionTestRuntime(): ReturnType<typeof createRuntimeFixture> {
  return createRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.infrastructure.contextBudget.thresholds.headroomTokens = 0;
      config.infrastructure.contextBudget.compaction.tailProtectTokens = 0;
    }),
  });
}

function buildToolMessages(count: number): Array<Record<string, unknown>> {
  return buildToolMessagesWithSize(count, LARGE_TOOL_RESULT.length);
}

function buildToolMessagesWithSize(
  count: number,
  rawChars: number,
): Array<Record<string, unknown>> {
  const content = "x".repeat(rawChars);
  return Array.from({ length: count }, (_, index) => ({
    role: "tool",
    tool_call_id: `call-${index + 1}`,
    name: "read",
    content: `${content}:${index + 1}`,
  }));
}

function invokeBeforeProviderRequestChain(
  handlers: Map<string, ExtensionTestHandler[]>,
  payload: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  let currentPayload: Record<string, unknown> = payload;
  for (const handler of handlers.get("before_provider_request") ?? []) {
    const nextPayload = handler(
      { payload: currentPayload },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );
    if (nextPayload && typeof nextPayload === "object" && !Array.isArray(nextPayload)) {
      currentPayload = nextPayload as Record<string, unknown>;
    }
  }
  return currentPayload;
}

describe("provider request reduction", () => {
  test("clears only older OpenAI-style tool result messages in the outbound copy", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-openai";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });

    const payload = {
      model: "gpt-5.4",
      messages: buildToolMessages(6),
    };

    const result = invokeBeforeProviderRequestChain(handlers, payload, sessionId);

    expect(result.messages as Array<Record<string, unknown>>).toEqual([
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "read",
        content: CLEARED_TOOL_RESULT_PLACEHOLDER,
      },
      {
        role: "tool",
        tool_call_id: "call-2",
        name: "read",
        content: CLEARED_TOOL_RESULT_PLACEHOLDER,
      },
      {
        role: "tool",
        tool_call_id: "call-3",
        name: "read",
        content: `${LARGE_TOOL_RESULT}:3`,
      },
      {
        role: "tool",
        tool_call_id: "call-4",
        name: "read",
        content: `${LARGE_TOOL_RESULT}:4`,
      },
      {
        role: "tool",
        tool_call_id: "call-5",
        name: "read",
        content: `${LARGE_TOOL_RESULT}:5`,
      },
      {
        role: "tool",
        tool_call_id: "call-6",
        name: "read",
        content: `${LARGE_TOOL_RESULT}:6`,
      },
    ]);
    expect(payload.messages[0]?.content).toBe(`${LARGE_TOOL_RESULT}:1`);
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        eligibleToolResults: 6,
        clearedToolResults: 2,
        classification: "prefixResetting",
        expectedCacheBreak: true,
      }),
    );
  });

  test("reduces OpenAI Responses text-only tool outputs but preserves recent items", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-responses";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });

    const payload = {
      input: Array.from({ length: 5 }, (_, index) => ({
        type: "function_call_output",
        call_id: `call-${index + 1}`,
        output: [
          {
            type: "input_text",
            text: `${LARGE_TOOL_RESULT}:${index + 1}`,
          },
        ],
      })),
    };

    const result = invokeBeforeProviderRequestChain(handlers, payload, sessionId);

    expect((result.input as Array<Record<string, unknown>>)[0]).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: [
        {
          type: "input_text",
          text: CLEARED_TOOL_RESULT_PLACEHOLDER,
        },
      ],
    });
    expect((result.input as Array<Record<string, unknown>>)[4]?.output).toEqual([
      {
        type: "input_text",
        text: `${LARGE_TOOL_RESULT}:5`,
      },
    ]);
  });

  test("protects OpenAI Responses tool outputs by resolving function_call names from call_id", () => {
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.compaction.tailProtectTokens = 0;
        config.infrastructure.contextBudget.compaction.protectedTools = [
          "workbench_compact",
          "recall_search",
        ];
      }),
    });
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-responses-protected";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });

    const input: Array<Record<string, unknown>> = [
      {
        type: "function_call",
        call_id: "call-protected",
        name: "workbench_compact",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call-protected",
        output: `${LARGE_TOOL_RESULT}:protected`,
      },
    ];
    for (let index = 1; index <= 6; index++) {
      input.push(
        {
          type: "function_call",
          call_id: `call-read-${index}`,
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: `call-read-${index}`,
          output: `${LARGE_TOOL_RESULT}:${index}`,
        },
      );
    }

    const result = invokeBeforeProviderRequestChain(handlers, { input }, sessionId);
    const reducedInput = result.input as Array<Record<string, unknown>>;
    const protectedOutput = reducedInput.find(
      (item) => item.type === "function_call_output" && item.call_id === "call-protected",
    );
    const clearedReadOutputs = reducedInput.filter(
      (item) =>
        item.type === "function_call_output" && item.output === CLEARED_TOOL_RESULT_PLACEHOLDER,
    );

    expect(protectedOutput?.output).toBe(`${LARGE_TOOL_RESULT}:protected`);
    expect(clearedReadOutputs.length).toBeGreaterThan(0);
  });

  test("protects OpenAI Chat tool messages by resolving tool_call_id names from assistant tool_calls", () => {
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.compaction.tailProtectTokens = 0;
        config.infrastructure.contextBudget.compaction.protectedTools = ["workbench_compact"];
      }),
    });
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-chat-tool-call-protected";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });

    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-protected",
            type: "function",
            function: { name: "workbench_compact", arguments: "{}" },
          },
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `call-read-${index + 1}`,
            type: "function",
            function: { name: "read", arguments: "{}" },
          })),
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-protected",
        content: `${LARGE_TOOL_RESULT}:protected`,
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        role: "tool",
        tool_call_id: `call-read-${index + 1}`,
        content: `${LARGE_TOOL_RESULT}:${index + 1}`,
      })),
    ];

    const result = invokeBeforeProviderRequestChain(
      handlers,
      { model: "gpt-5.4", messages },
      sessionId,
    );
    const reduced = result.messages as Array<Record<string, unknown>>;
    const protectedResult = reduced.find((message) => message.tool_call_id === "call-protected");
    const clearedReadCount = reduced.filter(
      (message) =>
        typeof message.tool_call_id === "string" &&
        message.tool_call_id.startsWith("call-read-") &&
        message.content === CLEARED_TOOL_RESULT_PLACEHOLDER,
    ).length;

    expect(protectedResult?.content).toBe(`${LARGE_TOOL_RESULT}:protected`);
    expect(clearedReadCount).toBeGreaterThan(0);
  });

  test("protects Anthropic tool_result blocks by resolving tool_use_id names from assistant tool_use blocks", () => {
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.compaction.tailProtectTokens = 0;
        config.infrastructure.contextBudget.compaction.protectedTools = ["workbench_compact"];
      }),
    });
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-anthropic-tool-use-protected";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });

    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "use-protected", name: "workbench_compact", input: {} },
          ...Array.from({ length: 6 }, (_, index) => ({
            type: "tool_use",
            id: `use-read-${index + 1}`,
            name: "read",
            input: {},
          })),
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "use-protected",
            content: [{ type: "text", text: `${LARGE_TOOL_RESULT}:protected` }],
          },
          ...Array.from({ length: 6 }, (_, index) => ({
            type: "tool_result",
            tool_use_id: `use-read-${index + 1}`,
            content: [{ type: "text", text: `${LARGE_TOOL_RESULT}:${index + 1}` }],
          })),
        ],
      },
    ];

    const result = invokeBeforeProviderRequestChain(
      handlers,
      { model: "claude-sonnet-4.5", messages },
      sessionId,
    );
    const reducedToolResults = ((result.messages as Array<Record<string, unknown>>)[1]?.content ??
      []) as Array<Record<string, unknown>>;
    const protectedResult = reducedToolResults.find(
      (block) => block.tool_use_id === "use-protected",
    );
    const clearedReadCount = reducedToolResults.filter(
      (block) =>
        typeof block.tool_use_id === "string" &&
        block.tool_use_id.startsWith("use-read-") &&
        Array.isArray(block.content) &&
        block.content.some(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            (part as { text?: unknown }).text === CLEARED_TOOL_RESULT_PLACEHOLDER,
        ),
    ).length;

    expect(protectedResult?.content).toEqual([
      { type: "text", text: `${LARGE_TOOL_RESULT}:protected` },
    ]);
    expect(clearedReadCount).toBeGreaterThan(0);
  });

  test("protects Google functionResponse outputs by reading functionResponse names", () => {
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.compaction.tailProtectTokens = 0;
        config.infrastructure.contextBudget.compaction.protectedTools = ["workbench_compact"];
      }),
    });
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-google-function-response-protected";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });

    const contents = [
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "workbench_compact",
              response: { output: `${LARGE_TOOL_RESULT}:protected` },
            },
          },
          ...Array.from({ length: 6 }, (_, index) => ({
            functionResponse: {
              name: "read",
              response: { output: `${LARGE_TOOL_RESULT}:${index + 1}` },
            },
          })),
        ],
      },
    ];

    const result = invokeBeforeProviderRequestChain(
      handlers,
      { model: "gemini-2.5-pro", contents },
      sessionId,
    );
    const parts = ((result.contents as Array<Record<string, unknown>>)[0]?.parts ?? []) as Array<
      Record<string, unknown>
    >;
    const protectedResponse = parts[0]?.functionResponse as
      | { response?: { output?: unknown } }
      | undefined;
    const clearedReadCount = parts.slice(1).filter((part) => {
      const functionResponse = part.functionResponse as
        | { response?: { output?: unknown } }
        | undefined;
      return functionResponse?.response?.output === CLEARED_TOOL_RESULT_PLACEHOLDER;
    }).length;

    expect(protectedResponse?.response?.output).toBe(`${LARGE_TOOL_RESULT}:protected`);
    expect(clearedReadCount).toBeGreaterThan(0);
  });

  test("allows transient reduction only for high pressure outside recovery posture", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-eligibility";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });
    const reducedPayload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessages(6),
      },
      sessionId,
    );
    expect((reducedPayload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      CLEARED_TOOL_RESULT_PLACEHOLDER,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        compactionAdvised: true,
        forcedCompaction: false,
      }),
    );

    runtime.operator.context.usage.observe(sessionId, {
      tokens: 0,
      contextWindow: 1_000,
      percent: 0,
    });
    const untouchedPayload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessages(6),
      },
      sessionId,
    );
    expect((untouchedPayload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      `${LARGE_TOOL_RESULT}:1`,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "context status is below the transient reduction threshold",
        compactionAdvised: false,
        forcedCompaction: false,
      }),
    );

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "provider_fallback_retry",
      status: "entered",
    });
    const recoveryPayload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessages(6),
      },
      sessionId,
    );
    expect((recoveryPayload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      `${LARGE_TOOL_RESULT}:1`,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "recovery posture is active",
        compactionAdvised: false,
        forcedCompaction: false,
      }),
    );
  });

  test("skips transient reduction when live usage is unavailable", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-model-window";

    registerProviderRequestReduction(api, runtime);
    const payload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "openai/gpt-4",
        messages: buildToolMessagesWithSize(6, 4_000),
      },
      sessionId,
    );
    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      `${"x".repeat(4_000)}:1`,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "context usage is unavailable",
        compactionAdvised: false,
        forcedCompaction: false,
      }),
    );
  });

  test("runtime usage takes precedence over payload estimation when live usage is available", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-runtime-usage-precedence";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 0,
      contextWindow: 1_000,
      percent: 0,
    });

    const payload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessagesWithSize(6, 3_000),
      },
      sessionId,
    );
    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      `${"x".repeat(3_000)}:1`,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "context status is below the transient reduction threshold",
        compactionAdvised: false,
        forcedCompaction: false,
      }),
    );
  });

  test("allows request-local reduction below pressure threshold when the provider cache clock is stale", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-cache-cold";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 20_000,
      contextWindow: 100_000,
      percent: 0.2,
    });
    recordMessageEnd({
      runtime,
      sessionId,
      timestamp: Date.now() - 6 * 60 * 1000,
    });

    const payload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessages(6),
      },
      sessionId,
    );

    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      CLEARED_TOOL_RESULT_PLACEHOLDER,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        reason: null,
        eligibleToolResults: 6,
        clearedToolResults: 2,
        compactionAdvised: false,
        forcedCompaction: false,
        classification: "cacheCold",
        expectedCacheBreak: false,
      }),
    );
  });

  test("treats an expired short-retention provider cache clock as cache cold", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-cache-expired";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 20_000,
      contextWindow: 100_000,
      percent: 0.2,
    });
    recordMessageEnd({
      runtime,
      sessionId,
      timestamp: Date.now() - 6 * 60 * 1000,
    });

    const payload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessages(6),
      },
      sessionId,
    );

    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      CLEARED_TOOL_RESULT_PLACEHOLDER,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        classification: "cacheCold",
        expectedCacheBreak: false,
      }),
    );
  });

  test("diagnostic-only recovery posture blocks transient reduction", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-diagnostic-only";

    registerProviderRequestReduction(api, runtime);
    Object.assign(runtime.inspect.lifecycle, {
      getSnapshot() {
        return {
          hydration: {
            status: "ready",
            issues: [],
          },
          execution: {
            kind: "idle",
          },
          recovery: {
            mode: "diagnostic_only",
            latestReason: "exact_history_over_budget",
            latestStatus: null,
            pendingFamily: null,
            degradedReason: "exact_history_over_budget",
            duplicateSideEffectSuppressionCount: 0,
            latestSourceEventId: null,
            latestSourceEventType: null,
            recentTransitions: [],
          },
          approval: {
            status: "idle",
            pendingCount: 0,
            requestId: null,
            toolCallId: null,
            toolName: null,
            subject: null,
          },
          tooling: {
            openToolCalls: [],
          },
          integrity: {
            status: "healthy",
            issues: [],
          },
          summary: {
            kind: "degraded",
            reason: "exact_history_over_budget",
            detail: null,
          },
        };
      },
    });

    const payload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessages(6),
      },
      sessionId,
    );
    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      `${LARGE_TOOL_RESULT}:1`,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "recovery posture is active",
        compactionAdvised: false,
        forcedCompaction: false,
      }),
    );
  });

  test("ordinary blocked tool lifecycle does not masquerade as recovery posture", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-open-tool-call";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });
    Object.assign(runtime.inspect.lifecycle, {
      getSnapshot() {
        return {
          hydration: {
            status: "ready",
            issues: [],
          },
          execution: {
            kind: "tool_executing",
            toolCallId: "tc-read",
            toolName: "read",
          },
          recovery: {
            mode: "normal",
            latestReason: null,
            latestStatus: null,
            pendingFamily: null,
            degradedReason: null,
            duplicateSideEffectSuppressionCount: 0,
            latestSourceEventId: null,
            latestSourceEventType: null,
            recentTransitions: [],
          },
          approval: {
            status: "idle",
            pendingCount: 0,
            requestId: null,
            toolCallId: null,
            toolName: null,
            subject: null,
          },
          tooling: {
            openToolCalls: [
              {
                toolCallId: "tc-read",
                toolName: "read",
                openedAt: 100,
              },
            ],
          },
          integrity: {
            status: "healthy",
            issues: [],
          },
          summary: {
            kind: "blocked",
            reason: "skill_repair_required",
            detail: "learning-research",
          },
        };
      },
    });

    const payload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessages(6),
      },
      sessionId,
    );

    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      CLEARED_TOOL_RESULT_PLACEHOLDER,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        reason: null,
        eligibleToolResults: 6,
        clearedToolResults: 2,
        compactionAdvised: true,
        forcedCompaction: false,
      }),
    );
  });

  test("records live transient reduction state when a high-pressure outbound payload is reduced", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-observation";

    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });

    const finalPayload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: buildToolMessages(6),
      },
      sessionId,
    );

    expect((finalPayload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      CLEARED_TOOL_RESULT_PLACEHOLDER,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        reason: null,
        eligibleToolResults: 6,
        clearedToolResults: 2,
        clearedChars: `${LARGE_TOOL_RESULT}:1`.length + `${LARGE_TOOL_RESULT}:2`.length,
        compactionAdvised: true,
        forcedCompaction: false,
      }),
    );
    expect(readTransientReduction(runtime, sessionId)?.estimatedTokenSavings).toBeGreaterThan(0);
    expect(
      runtime.inspect.events.records
        .queryStructured(sessionId)
        .filter((event) => event.type.startsWith("context_cache")),
    ).toHaveLength(0);
    expect(
      readContextEvidenceRecords({
        workspaceRoot: runtime.identity.workspaceRoot,
        sessionIds: [sessionId],
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "transient_reduction",
        sessionId,
        status: "completed",
        reason: null,
        eligibleToolResults: 6,
        clearedToolResults: 2,
        compactionAdvised: true,
        forcedCompaction: false,
      }),
    ]);
  });

  test("skips reduction during output-budget recovery and preserves the recovery payload patch", () => {
    const runtime = createReductionTestRuntime();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-reduction-output-budget";

    registerProviderRequestReduction(api, runtime);
    registerProviderRequestRecovery(api, runtime);

    runtime.operator.context.usage.observe(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "output_budget_escalation",
      status: "entered",
      model: "openai/gpt-5.4",
    });
    armNextPromptOutputBudgetEscalation(runtime, {
      sessionId,
      targetMaxTokens: 16_384,
      model: "openai/gpt-5.4",
    });

    const finalPayload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        max_tokens: 2_048,
        messages: buildToolMessages(6),
      },
      sessionId,
    );

    expect(finalPayload).toMatchObject({
      model: "gpt-5.4",
      max_tokens: 16_384,
    });
    expect((finalPayload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      `${LARGE_TOOL_RESULT}:1`,
    );
    expect(readTransientReduction(runtime, sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "recovery posture is active",
        eligibleToolResults: 0,
        clearedToolResults: 0,
        compactionAdvised: false,
        forcedCompaction: false,
      }),
    );

    const transitionPayloads = runtime.inspect.events.records
      .queryStructured(sessionId, {
        type: "session_turn_transition",
      })
      .map((event) => event.payload);
    expect(transitionPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "output_budget_escalation",
          status: "entered",
          model: "openai/gpt-5.4",
        }),
        expect.objectContaining({
          reason: "output_budget_escalation",
          status: "completed",
          model: "openai/gpt-5.4",
        }),
      ]),
    );
    expect(
      runtime.inspect.events.records
        .queryStructured(sessionId)
        .filter((event) => event.type.startsWith("context_cache")),
    ).toHaveLength(0);
    expect(
      readContextEvidenceRecords({
        workspaceRoot: runtime.identity.workspaceRoot,
        sessionIds: [sessionId],
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "transient_reduction",
        sessionId,
        status: "skipped",
        reason: "recovery posture is active",
        eligibleToolResults: 0,
        clearedToolResults: 0,
        compactionAdvised: false,
        forcedCompaction: false,
      }),
    ]);
  });

  test("does not clear tool messages whose tool name is in protectedTools", () => {
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.thresholds.headroomTokens = 0;
        config.infrastructure.contextBudget.compaction.tailProtectTokens = 0;
        config.infrastructure.contextBudget.compaction.protectedTools = [
          "workbench_compact",
          "recall_search",
        ];
      }),
    });
    const sessionId = "protected-tools-1";
    const { api, handlers } = createMockExtensionApi();
    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 9000,
      contextWindow: 10_000,
      percent: 90,
    });

    const messages = [
      { role: "tool", tool_call_id: "c-1", name: "workbench_compact", content: LARGE_TOOL_RESULT },
      { role: "tool", tool_call_id: "c-2", name: "recall_search", content: LARGE_TOOL_RESULT },
      { role: "tool", tool_call_id: "c-3", name: "read", content: LARGE_TOOL_RESULT + ":3" },
      { role: "tool", tool_call_id: "c-4", name: "read", content: LARGE_TOOL_RESULT + ":4" },
      { role: "tool", tool_call_id: "c-5", name: "read", content: LARGE_TOOL_RESULT + ":5" },
      { role: "tool", tool_call_id: "c-6", name: "read", content: LARGE_TOOL_RESULT + ":6" },
      { role: "tool", tool_call_id: "c-7", name: "read", content: LARGE_TOOL_RESULT + ":7" },
      { role: "tool", tool_call_id: "c-8", name: "read", content: LARGE_TOOL_RESULT + ":8" },
    ];
    const result = invokeBeforeProviderRequestChain(
      handlers,
      { model: "gpt-5.4", messages },
      sessionId,
    );

    const reduced = result.messages as Array<Record<string, unknown>>;
    expect(reduced[0]?.content).toBe(LARGE_TOOL_RESULT);
    expect(reduced[1]?.content).toBe(LARGE_TOOL_RESULT);
    const clearedReadCount = reduced.filter(
      (m) => m.name === "read" && m.content === CLEARED_TOOL_RESULT_PLACEHOLDER,
    ).length;
    expect(clearedReadCount).toBeGreaterThan(0);
  });

  test("preserves all tool results when tail-protect token budget exceeds the cumulative tail", () => {
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.thresholds.headroomTokens = 0;
        config.infrastructure.contextBudget.compaction.tailProtectTokens = 1_000_000;
      }),
    });
    const sessionId = "tail-protect-large-1";
    const { api, handlers } = createMockExtensionApi();
    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 9000,
      contextWindow: 10_000,
      percent: 90,
    });

    const result = invokeBeforeProviderRequestChain(
      handlers,
      { model: "gpt-5.4", messages: buildToolMessages(8) },
      sessionId,
    );
    const reduced = result.messages as Array<Record<string, unknown>>;
    expect(reduced.every((m) => m.content !== CLEARED_TOOL_RESULT_PLACEHOLDER)).toBe(true);
  });

  test("clears only the prefix that overflows a finite tail-protect budget", () => {
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.thresholds.headroomTokens = 0;
        config.infrastructure.contextBudget.compaction.tailProtectTokens = 256;
      }),
    });
    const sessionId = "tail-protect-finite-1";
    const { api, handlers } = createMockExtensionApi();
    registerProviderRequestReduction(api, runtime);
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 9000,
      contextWindow: 10_000,
      percent: 90,
    });

    const result = invokeBeforeProviderRequestChain(
      handlers,
      { model: "gpt-5.4", messages: buildToolMessages(8) },
      sessionId,
    );
    const reduced = result.messages as Array<Record<string, unknown>>;
    const clearedCount = reduced.filter(
      (m) => m.content === CLEARED_TOOL_RESULT_PLACEHOLDER,
    ).length;
    expect(clearedCount).toBeGreaterThan(0);
    expect(clearedCount).toBeLessThan(reduced.length);
    const lastFour = reduced.slice(-4);
    expect(lastFour.every((m) => m.content !== CLEARED_TOOL_RESULT_PLACEHOLDER)).toBe(true);
  });
});
