import { describe, expect, test } from "bun:test";
import { registerProviderRequestRecovery } from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-recovery.js";
import { armNextPromptOutputBudgetEscalation } from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/recovery/output-budget-state.js";
import { recordSessionTurnTransition } from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/turn-transition.js";
import { createMockExtensionApi, invokeHandler } from "../../helpers/extension.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("provider request recovery", () => {
  test("patches the next provider payload with an escalated output budget and records completion", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-recovery-completed";

    registerProviderRequestRecovery(api, runtime);
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

    const patched = invokeHandler<Record<string, unknown>>(
      handlers,
      "before_provider_request",
      {
        payload: {
          model: "gpt-5.4",
          max_tokens: 2_048,
          generationConfig: {
            maxOutputTokens: 1_024,
          },
        },
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    expect(patched).toEqual({
      model: "gpt-5.4",
      max_tokens: 16_384,
      generationConfig: {
        maxOutputTokens: 16_384,
      },
    });
    expect(
      runtime.inspect.events.records
        .queryStructured(sessionId, {
          type: "session_turn_transition",
        })
        .map((event) => event.payload),
    ).toEqual(
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
  });

  test("records skipped escalation when the provider payload has no supported output-budget field", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-recovery-skipped";

    registerProviderRequestRecovery(api, runtime);
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

    const patched = invokeHandler<Record<string, unknown> | undefined>(
      handlers,
      "before_provider_request",
      {
        payload: {
          model: "gpt-5.4",
          temperature: 0.2,
        },
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    expect(patched).toBeUndefined();
    expect(
      runtime.inspect.events.records
        .queryStructured(sessionId, {
          type: "session_turn_transition",
        })
        .map((event) => event.payload),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "output_budget_escalation",
          status: "entered",
          model: "openai/gpt-5.4",
        }),
        expect.objectContaining({
          reason: "output_budget_escalation",
          status: "skipped",
          model: "openai/gpt-5.4",
        }),
      ]),
    );
  });

  test("recognizes supported output-budget fields across top-level and nested payloads", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockExtensionApi();
    const sessionId = "provider-request-recovery-supported-fields";

    registerProviderRequestRecovery(api, runtime);
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "output_budget_escalation",
      status: "entered",
      model: "openai/gpt-5.4",
    });
    armNextPromptOutputBudgetEscalation(runtime, {
      sessionId,
      targetMaxTokens: 8_192,
      model: "openai/gpt-5.4",
    });

    const patched = invokeHandler<Record<string, unknown>>(
      handlers,
      "before_provider_request",
      {
        payload: {
          max_completion_tokens: 4_096,
          generationConfig: {
            maxOutputTokens: 2_048,
          },
        },
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    expect(patched).toEqual({
      max_completion_tokens: 8_192,
      generationConfig: {
        maxOutputTokens: 8_192,
      },
    });
  });
});
