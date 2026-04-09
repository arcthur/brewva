import { describe, expect, test } from "bun:test";
import { createHostedRuntimePort } from "@brewva/brewva-runtime";
import { readContextEvidenceRecords } from "../../../packages/brewva-gateway/src/runtime-plugins/context-evidence.js";
import { registerProviderRequestRecovery } from "../../../packages/brewva-gateway/src/runtime-plugins/provider-request-recovery.js";
import {
  PROVIDER_REQUEST_REDUCTION_TEST_ONLY,
  registerProviderRequestReduction,
} from "../../../packages/brewva-gateway/src/runtime-plugins/provider-request-reduction.js";
import { armNextPromptOutputBudgetEscalation } from "../../../packages/brewva-gateway/src/session/prompt-recovery-state.js";
import { recordSessionTurnTransition } from "../../../packages/brewva-gateway/src/session/turn-transition.js";
import {
  createMockRuntimePluginApi,
  type RuntimePluginTestHandler,
} from "../../helpers/runtime-plugin.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

const LARGE_TOOL_RESULT = "x".repeat(
  PROVIDER_REQUEST_REDUCTION_TEST_ONLY.MIN_CLEARABLE_TOOL_RESULT_CHARS,
);

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
    const payload = {
      model: "gpt-5.4",
      messages: buildToolMessages(6),
    };

    const result =
      PROVIDER_REQUEST_REDUCTION_TEST_ONLY.applyTransientOutboundReductionToPayload(payload);

    expect(result.status).toBe("completed");
    expect(result.eligibleToolResults).toBe(6);
    expect(result.clearedToolResults).toBe(2);
    expect(result.clearedChars).toBe(
      `${LARGE_TOOL_RESULT}:1`.length + `${LARGE_TOOL_RESULT}:2`.length,
    );
    expect(result.estimatedTokenSavings).toBeGreaterThan(0);
    expect((result.payload as { messages: Array<Record<string, unknown>> }).messages).toEqual([
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "read",
        content: PROVIDER_REQUEST_REDUCTION_TEST_ONLY.CLEARED_TOOL_RESULT_PLACEHOLDER,
      },
      {
        role: "tool",
        tool_call_id: "call-2",
        name: "read",
        content: PROVIDER_REQUEST_REDUCTION_TEST_ONLY.CLEARED_TOOL_RESULT_PLACEHOLDER,
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
  });

  test("reduces OpenAI Responses text-only tool outputs but preserves recent items", () => {
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

    const result =
      PROVIDER_REQUEST_REDUCTION_TEST_ONLY.applyTransientOutboundReductionToPayload(payload);

    expect(result.status).toBe("completed");
    expect(result.eligibleToolResults).toBe(5);
    expect(result.clearedToolResults).toBe(1);
    expect(result.clearedChars).toBe(`${LARGE_TOOL_RESULT}:1`.length);
    expect(result.estimatedTokenSavings).toBeGreaterThan(0);
    expect((result.payload as { input: Array<Record<string, unknown>> }).input[0]).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: [
        {
          type: "input_text",
          text: PROVIDER_REQUEST_REDUCTION_TEST_ONLY.CLEARED_TOOL_RESULT_PLACEHOLDER,
        },
      ],
    });
    expect((result.payload as { input: Array<Record<string, unknown>> }).input[4]?.output).toEqual([
      {
        type: "input_text",
        text: `${LARGE_TOOL_RESULT}:5`,
      },
    ]);
  });

  test("allows transient reduction only for high pressure outside recovery posture", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "provider-request-reduction-eligibility";

    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 88,
    });
    expect(
      PROVIDER_REQUEST_REDUCTION_TEST_ONLY.resolveTransientOutboundReductionEligibility(
        createHostedRuntimePort(runtime),
        sessionId,
      ),
    ).toEqual({
      allowed: true,
      detail: null,
      pressureLevel: "high",
    });

    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 0,
      contextWindow: 1_000,
      percent: 0,
    });
    expect(
      PROVIDER_REQUEST_REDUCTION_TEST_ONLY.resolveTransientOutboundReductionEligibility(
        createHostedRuntimePort(runtime),
        sessionId,
        {
          model: "gpt-5.4",
          messages: buildToolMessages(6),
        },
      ),
    ).toEqual({
      allowed: true,
      detail: null,
      pressureLevel: "high",
    });

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "provider_fallback_retry",
      status: "entered",
    });
    expect(
      PROVIDER_REQUEST_REDUCTION_TEST_ONLY.resolveTransientOutboundReductionEligibility(
        createHostedRuntimePort(runtime),
        sessionId,
      ),
    ).toEqual({
      allowed: false,
      detail: "recovery posture is active",
      pressureLevel: "unknown",
    });
  });

  test("uses payload model metadata when live usage is unavailable", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "provider-request-reduction-model-window";

    expect(
      PROVIDER_REQUEST_REDUCTION_TEST_ONLY.resolveTransientOutboundReductionEligibility(
        createHostedRuntimePort(runtime),
        sessionId,
        {
          model: "azure-openai-responses/gpt-4",
          messages: buildToolMessagesWithSize(6, 4_000),
        },
      ),
    ).toEqual({
      allowed: true,
      detail: null,
      pressureLevel: "high",
    });
  });

  test("estimated critical pressure still defers to replay-visible compaction handling", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "provider-request-reduction-estimated-critical";

    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 0,
      contextWindow: 1_000,
      percent: 0,
    });

    expect(
      PROVIDER_REQUEST_REDUCTION_TEST_ONLY.resolveTransientOutboundReductionEligibility(
        createHostedRuntimePort(runtime),
        sessionId,
        {
          model: "gpt-5.4",
          messages: buildToolMessagesWithSize(6, 3_000),
        },
      ),
    ).toEqual({
      allowed: false,
      detail: "hard-limit posture requires replay-visible compaction handling",
      pressureLevel: "critical",
    });
  });

  test("records live transient reduction state when a high-pressure outbound payload is reduced", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-reduction-observation";

    registerProviderRequestReduction(api, createHostedRuntimePort(runtime));
    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 0,
      contextWindow: 1_000,
      percent: 0,
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
      PROVIDER_REQUEST_REDUCTION_TEST_ONLY.CLEARED_TOOL_RESULT_PLACEHOLDER,
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
