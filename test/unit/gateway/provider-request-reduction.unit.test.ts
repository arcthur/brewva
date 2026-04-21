import { describe, expect, test } from "bun:test";
import { recordSessionTurnTransition } from "@brewva/brewva-gateway";
import {
  readContextEvidenceRecords,
  registerProviderRequestRecovery,
  registerProviderRequestReduction,
} from "@brewva/brewva-gateway/runtime-plugins";
import { createHostedRuntimePort } from "@brewva/brewva-runtime";
import { armNextPromptOutputBudgetEscalation } from "../../../packages/brewva-gateway/src/session/prompt-recovery-state.js";
import {
  createMockRuntimePluginApi,
  type RuntimePluginTestHandler,
} from "../../helpers/runtime-plugin.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

const CLEARED_TOOL_RESULT_PLACEHOLDER = "[cleared_for_request]";
const MIN_CLEARABLE_TOOL_RESULT_CHARS = 512;
const LARGE_TOOL_RESULT = "x".repeat(MIN_CLEARABLE_TOOL_RESULT_CHARS);

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
  handlers: Map<string, RuntimePluginTestHandler[]>,
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
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-openai";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    runtime.maintain.context.observeUsage(sessionId, {
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        eligibleToolResults: 6,
        clearedToolResults: 2,
      }),
    );
  });

  test("reduces OpenAI Responses text-only tool outputs but preserves recent items", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-responses";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    runtime.maintain.context.observeUsage(sessionId, {
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

  test("allows transient reduction only for high pressure outside recovery posture", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-eligibility";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    runtime.maintain.context.observeUsage(sessionId, {
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        pressureLevel: "high",
      }),
    );

    runtime.maintain.context.observeUsage(sessionId, {
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "context pressure is below the transient reduction threshold",
        pressureLevel: "none",
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "recovery posture is active",
        pressureLevel: "unknown",
      }),
    );
  });

  test("skips transient reduction when live usage is unavailable", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-model-window";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    const payload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "azure-openai-responses/gpt-4",
        messages: buildToolMessagesWithSize(6, 4_000),
      },
      sessionId,
    );
    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      `${"x".repeat(4_000)}:1`,
    );
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "context usage is unavailable",
        pressureLevel: "unknown",
      }),
    );
  });

  test("runtime usage takes precedence over payload estimation when live usage is available", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-runtime-usage-precedence";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    runtime.maintain.context.observeUsage(sessionId, {
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "context pressure is below the transient reduction threshold",
        pressureLevel: "none",
      }),
    );
  });

  test("diagnostic-only recovery posture blocks transient reduction", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-diagnostic-only";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
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
          skill: {
            posture: "none",
            activeSkillName: null,
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "recovery posture is active",
        pressureLevel: "unknown",
      }),
    );
  });

  test("ordinary blocked tool lifecycle does not masquerade as recovery posture", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-open-tool-call";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    runtime.maintain.context.observeUsage(sessionId, {
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
          skill: {
            posture: "repair_required",
            activeSkillName: "learning-research",
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        reason: null,
        eligibleToolResults: 6,
        clearedToolResults: 2,
        pressureLevel: "high",
      }),
    );
  });

  test("records live transient reduction state when a high-pressure outbound payload is reduced", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-observation";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    runtime.maintain.context.observeUsage(sessionId, {
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "completed",
        reason: null,
        eligibleToolResults: 6,
        clearedToolResults: 2,
        clearedChars: `${LARGE_TOOL_RESULT}:1`.length + `${LARGE_TOOL_RESULT}:2`.length,
        pressureLevel: "high",
      }),
    );
    expect(
      runtime.inspect.context.getTransientReduction(sessionId)?.estimatedTokenSavings,
    ).toBeGreaterThan(0);
    expect(
      runtime.inspect.events
        .queryStructured(sessionId)
        .filter((event) => event.type.startsWith("context_cache")),
    ).toHaveLength(0);
    expect(
      readContextEvidenceRecords({
        workspaceRoot: runtime.workspaceRoot,
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
        pressureLevel: "high",
      }),
    ]);
  });

  test("skips reduction during output-budget recovery and preserves the recovery payload patch", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-output-budget";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    registerProviderRequestRecovery(api, runtime);

    runtime.maintain.context.observeUsage(sessionId, {
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
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "recovery posture is active",
        eligibleToolResults: 0,
        clearedToolResults: 0,
        pressureLevel: "unknown",
      }),
    );

    const transitionPayloads = runtime.inspect.events
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
      runtime.inspect.events
        .queryStructured(sessionId)
        .filter((event) => event.type.startsWith("context_cache")),
    ).toHaveLength(0);
    expect(
      readContextEvidenceRecords({
        workspaceRoot: runtime.workspaceRoot,
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
        pressureLevel: "unknown",
      }),
    ]);
  });
});
