import { describe, expect, test } from "bun:test";
import { PROVIDER_REQUEST_RECOVERY_TEST_ONLY } from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-recovery.js";

const { applyOutputBudgetEscalationToPayload, readCurrentOutputBudget } =
  PROVIDER_REQUEST_RECOVERY_TEST_ONLY;
const { resolveOutputBudgetEscalationTarget } = PROVIDER_REQUEST_RECOVERY_TEST_ONLY;

describe("readCurrentOutputBudget", () => {
  test("reads the highest configured output budget across supported fields", () => {
    expect(readCurrentOutputBudget({ max_tokens: 1_000 })).toBe(1_000);
    expect(
      readCurrentOutputBudget({
        max_tokens: 1_000,
        generationConfig: { maxOutputTokens: 4_000 },
      }),
    ).toBe(4_000);
  });

  test("returns null when no supported field is present", () => {
    expect(readCurrentOutputBudget({ messages: [] })).toBeNull();
    expect(readCurrentOutputBudget(null)).toBeNull();
    expect(readCurrentOutputBudget("not-an-object")).toBeNull();
  });
});

describe("resolveOutputBudgetEscalationTarget", () => {
  test("doubles the current budget clamped to the model ceiling", () => {
    expect(
      resolveOutputBudgetEscalationTarget({ currentBudget: 1_000, maxOutputTokens: 8_192 }),
    ).toBe(2_000);
    expect(
      resolveOutputBudgetEscalationTarget({ currentBudget: 5_000, maxOutputTokens: 8_192 }),
    ).toBe(8_192);
  });

  test("skips when the budget is already at or above the ceiling", () => {
    expect(
      resolveOutputBudgetEscalationTarget({ currentBudget: 8_192, maxOutputTokens: 8_192 }),
    ).toBeNull();
    expect(
      resolveOutputBudgetEscalationTarget({ currentBudget: 9_000, maxOutputTokens: 8_192 }),
    ).toBeNull();
  });

  test("is capability-gated: skips when current or ceiling is unknown", () => {
    expect(
      resolveOutputBudgetEscalationTarget({ currentBudget: null, maxOutputTokens: 8_192 }),
    ).toBeNull();
    expect(
      resolveOutputBudgetEscalationTarget({ currentBudget: 1_000, maxOutputTokens: null }),
    ).toBeNull();
    expect(
      resolveOutputBudgetEscalationTarget({ currentBudget: 0, maxOutputTokens: 8_192 }),
    ).toBeNull();
  });
});

describe("applyOutputBudgetEscalationToPayload", () => {
  test("patches every supported field below the target without mutating the original", () => {
    const payload = {
      max_tokens: 1_000,
      generationConfig: { maxOutputTokens: 1_500 },
      messages: [{ role: "user", content: "hi" }],
    };
    const result = applyOutputBudgetEscalationToPayload(payload, 2_000);

    expect(result.status).toBe("completed");
    expect(payload.max_tokens).toBe(1_000);
    expect(payload.generationConfig.maxOutputTokens).toBe(1_500);
    const patched = result.payload as typeof payload;
    expect(patched.max_tokens).toBe(2_000);
    expect(patched.generationConfig.maxOutputTokens).toBe(2_000);
    expect(patched.messages).toEqual(payload.messages);
  });

  test("skips when the payload already uses the maximum budget", () => {
    const result = applyOutputBudgetEscalationToPayload({ max_tokens: 4_000 }, 2_000);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("maximum configured output budget");
  });

  test("skips when no supported output-budget field exists", () => {
    const result = applyOutputBudgetEscalationToPayload({ messages: [] }, 2_000);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("does not expose");
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import { registerProviderRequestRecovery } from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-recovery.js";
import { registerProviderRequestReduction } from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

type BeforeProviderRequestHandler = (
  event: {
    type: "before_provider_request";
    payload: unknown;
    provider: string;
    api: string;
    modelId: string;
  },
  ctx: { sessionManager: { getSessionId(): string } },
) => unknown;

function captureBeforeProviderRequestHandler(
  register: (api: InternalHostPluginApi, runtime: never) => void,
  runtime: unknown,
): BeforeProviderRequestHandler {
  const handlers: BeforeProviderRequestHandler[] = [];
  const api = {
    on(event: string, handler: BeforeProviderRequestHandler) {
      if (event === "before_provider_request") {
        handlers.push(handler);
      }
    },
  } as unknown as InternalHostPluginApi;
  register(api, runtime as never);
  const handler = handlers[0];
  if (!handler) {
    throw new Error("before_provider_request handler not registered");
  }
  return handler;
}

describe("registerProviderRequestRecovery one-shot semantics", () => {
  function recordAssistantLengthStop(
    runtime: ReturnType<typeof createRuntimeInstanceFixture>,
    sessionId: string,
  ) {
    runtime.runtime.kernel.recordAdvisoryEvent({
      sessionId,
      namespace: "runtime.ops",
      kind: "message.end",
      version: 1,
      payload: {
        role: "assistant",
        stopReason: "length",
      },
    });
  }

  test("escalates once per length stop and marks the payload full-fidelity", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-output-recovery-one-shot-")),
    });
    const sessionId = "output-recovery-session";
    runtime.ops.context.usage.observe(sessionId, {
      tokens: 1_000,
      contextWindow: 100_000,
      percent: 1,
      maxOutputTokens: 8_192,
    });
    recordAssistantLengthStop(runtime, sessionId);

    const handler = captureBeforeProviderRequestHandler(
      registerProviderRequestRecovery as never,
      runtime,
    );
    const ctx = { sessionManager: { getSessionId: () => sessionId } };
    const event = {
      type: "before_provider_request" as const,
      payload: { max_tokens: 1_000, messages: [] },
      provider: "anthropic",
      api: "messages",
      modelId: "claude-test",
    };

    const escalated = handler(event, ctx) as { max_tokens: number } | undefined;
    expect(escalated?.max_tokens).toBe(2_000);
    expect(PROVIDER_REQUEST_RECOVERY_TEST_ONLY.isOutputBudgetEscalatedPayload(escalated)).toBe(
      true,
    );

    const second = handler(event, ctx);
    expect(second).toBe(undefined);

    recordAssistantLengthStop(runtime, sessionId);
    const third = handler(event, ctx) as { max_tokens: number } | undefined;
    expect(third?.max_tokens).toBe(2_000);
  });

  test("transient reduction skips full-fidelity escalated payloads", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-output-recovery-reduction-skip-")),
    });
    const sessionId = "output-recovery-reduction-session";
    runtime.ops.context.usage.observe(sessionId, {
      tokens: 1_000,
      contextWindow: 100_000,
      percent: 1,
      maxOutputTokens: 8_192,
    });
    recordAssistantLengthStop(runtime, sessionId);

    const recoveryHandler = captureBeforeProviderRequestHandler(
      registerProviderRequestRecovery as never,
      runtime,
    );
    const reductionHandler = captureBeforeProviderRequestHandler(
      registerProviderRequestReduction as never,
      runtime,
    );
    const ctx = { sessionManager: { getSessionId: () => sessionId } };
    const event = {
      type: "before_provider_request" as const,
      payload: { max_tokens: 1_000, messages: [] },
      provider: "anthropic",
      api: "messages",
      modelId: "claude-test",
    };

    const escalated = recoveryHandler(event, ctx) as { max_tokens: number };
    expect(escalated.max_tokens).toBe(2_000);
    const reduced = reductionHandler({ ...event, payload: escalated }, ctx);
    expect(reduced).toBe(undefined);
  });
});
