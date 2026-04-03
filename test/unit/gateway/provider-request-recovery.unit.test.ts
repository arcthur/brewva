import { describe, expect, test } from "bun:test";
import {
  PROVIDER_REQUEST_RECOVERY_TEST_ONLY,
  registerProviderRequestRecovery,
} from "../../../packages/brewva-gateway/src/runtime-plugins/provider-request-recovery.js";
import { armNextPromptOutputBudgetEscalation } from "../../../packages/brewva-gateway/src/session/prompt-recovery-state.js";
import { createMockRuntimePluginApi, invokeHandler } from "../../helpers/runtime-plugin.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("provider request recovery", () => {
  test("patches the next provider payload with an escalated output budget and records completion", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-recovery-completed";

    registerProviderRequestRecovery(api, runtime);
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
      runtime.events.queryStructured(sessionId, {
        type: "session_turn_transition",
      })[0]?.payload,
    ).toMatchObject({
      reason: "output_budget_escalation",
      status: "completed",
      model: "openai/gpt-5.4",
    });
  });

  test("records skipped escalation when the provider payload has no supported output-budget field", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "provider-request-recovery-skipped";

    registerProviderRequestRecovery(api, runtime);
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
      runtime.events.queryStructured(sessionId, {
        type: "session_turn_transition",
      })[0]?.payload,
    ).toMatchObject({
      reason: "output_budget_escalation",
      status: "skipped",
      model: "openai/gpt-5.4",
    });
  });

  test("recognizes supported output-budget fields across top-level and nested payloads", () => {
    expect(
      PROVIDER_REQUEST_RECOVERY_TEST_ONLY.applyOutputBudgetEscalationToPayload(
        {
          max_completion_tokens: 4_096,
          generationConfig: {
            maxOutputTokens: 2_048,
          },
        },
        8_192,
      ),
    ).toEqual({
      payload: {
        max_completion_tokens: 8_192,
        generationConfig: {
          maxOutputTokens: 8_192,
        },
      },
      status: "completed",
      detail: null,
    });
  });
});
