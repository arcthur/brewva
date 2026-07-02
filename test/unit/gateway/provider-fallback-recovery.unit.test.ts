import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import { createHostedRuntimeProviderPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-execution-ports.js";
import { ProviderFallbackExhaustedError } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-provider.js";
import { selectBrewvaFallbackModel } from "../../../packages/brewva-gateway/src/policy/model-routing/api.js";
import { createProviderEventStream } from "../../helpers/effect-stream.js";
import { createRuntimeProviderFaceFixture } from "../../helpers/runtime-provider-face.js";

// Recovery-loop honesty invariants:
// 1. Exhaustion surfaces the FIRST attempt's error (the model the user selected)
//    with the full route trail — never only the last fallback's error.
// 2. The affinity selector excludes already-attempted/unavailable models BEFORE
//    ranking, so a top-ranked-but-burned candidate does not read as exhaustion
//    while viable lower-ranked candidates remain.
// 3. A provider-classified PERMANENT rejection (`retryable: false`) is remembered
//    on the session face, and later fallbacks stop re-dialing that model.

const SOURCE_ID = "provider-fallback-recovery-unit-test";

function createMessage(api: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: "unit-provider",
    model: "unit-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createRuntimeModel(id: string, api: string): BrewvaRegisteredModel {
  return {
    provider: "unit-provider",
    id,
    name: id,
    api,
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function createRuntimeProviderInput(sessionId: string) {
  return {
    turn: { sessionId, prompt: "next" },
    prompt: {
      status: "ready" as const,
      sessionId,
      messages: [],
      messageSourceEventIds: [],
      admittedBlocks: [],
      droppedAdvisoryBlocks: [],
      tokenEstimate: 0,
      cache: { stablePrefix: false },
    },
  };
}

function permanentRejection(api: string, message: string) {
  const partial = createMessage(api);
  return createProviderEventStream([
    {
      type: "error" as const,
      reason: "error" as const,
      retryable: false,
      error: {
        ...partial,
        stopReason: "error" as const,
        errorMessage: message,
      },
    },
  ]);
}

function successStream(api: string) {
  const partial = createMessage(api);
  return createProviderEventStream([
    { type: "text_delta" as const, contentIndex: 0, delta: "ok", partial },
    {
      type: "done" as const,
      reason: "stop" as const,
      message: {
        ...partial,
        content: [{ type: "text" as const, text: "ok" }],
        stopReason: "stop" as const,
      },
    },
  ]);
}

interface RecoveryHarness {
  readonly api: string;
  readonly models: readonly BrewvaRegisteredModel[];
  readonly dialed: string[];
  readonly providerFallbacks: Record<string, unknown>[];
  readonly unavailable: Map<string, string>;
  readonly face: ReturnType<typeof createRuntimeProviderFaceFixture>;
  readonly session: unknown;
}

type AttemptOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

function createRecoveryHarness(input: {
  api: string;
  modelIds: readonly string[];
  outcomeFor: (modelId: string, dialed: readonly string[]) => AttemptOutcome;
}): RecoveryHarness {
  const models = input.modelIds.map((id) => createRuntimeModel(id, input.api));
  const primary = models[0];
  if (!primary) {
    throw new Error("harness requires at least one model");
  }
  const dialed: string[] = [];
  const providerFallbacks: Record<string, unknown>[] = [];
  const unavailable = new Map<string, string>();

  registerApiProvider(
    {
      api: input.api,
      stream() {
        return createProviderEventStream();
      },
      streamSimple(providerModel, _context, options) {
        dialed.push(providerModel.id);
        const fallback = options?.metadata?.providerFallback;
        if (fallback && typeof fallback === "object") {
          providerFallbacks.push(fallback as Record<string, unknown>);
        }
        const outcome = input.outcomeFor(providerModel.id, dialed);
        return outcome.ok
          ? successStream(providerModel.api)
          : permanentRejection(providerModel.api, outcome.message);
      },
    },
    SOURCE_ID,
  );

  const face = createRuntimeProviderFaceFixture({
    model: primary,
    getModelCatalog() {
      return {
        getAll() {
          return models;
        },
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "unit-key" };
        },
      };
    },
    markProviderModelUnavailable({ provider, modelId, reason }) {
      unavailable.set(`${provider}/${modelId}`, reason);
    },
    getUnavailableProviderModels() {
      return unavailable;
    },
  });
  const session = {
    getRegisteredTools() {
      return [];
    },
    getRuntimeProviderFace() {
      return face;
    },
    createRuntimeToolContext() {
      return {
        getSystemPrompt() {
          return "";
        },
      };
    },
  };
  return { api: input.api, models, dialed, providerFallbacks, unavailable, face, session };
}

async function drainStream(harness: RecoveryHarness, sessionId: string): Promise<unknown[]> {
  const provider = createHostedRuntimeProviderPort(harness.session as never, harness.face);
  const frames: unknown[] = [];
  for await (const frame of provider.stream(createRuntimeProviderInput(sessionId))) {
    frames.push(frame);
  }
  return frames;
}

describe("selectBrewvaFallbackModel exclusion", () => {
  const api = "fallback-exclusion-selector-test";
  const alpha = createRuntimeModel("alpha", api);
  const alphaMini = createRuntimeModel("alpha-mini", api);
  const gamma = createRuntimeModel("gamma", api);

  test("without exclusions the shared-stem sibling ranks first", () => {
    const picked = selectBrewvaFallbackModel({
      currentModel: alphaMini,
      availableModels: [alpha, alphaMini, gamma],
    });
    expect(picked?.id).toBe("alpha");
  });

  test("an excluded top-ranked candidate yields the next viable model, not exhaustion", () => {
    const picked = selectBrewvaFallbackModel({
      currentModel: alphaMini,
      availableModels: [alpha, alphaMini, gamma],
      excludeModelKeys: new Set(["unit-provider/alpha"]),
    });
    expect(picked?.id).toBe("gamma");
  });
});

describe("provider fallback recovery", () => {
  test("exhaustion surfaces the first attempt's error with the full route trail", async () => {
    clearApiProviders();
    const api = "fallback-exhaustion-test";
    const harness = createRecoveryHarness({
      api,
      modelIds: ["alpha", "alpha-mini", "gamma"],
      outcomeFor: (modelId) => ({
        ok: false,
        message: `The '${modelId}' model is not supported for this account.`,
      }),
    });

    try {
      let thrown: unknown;
      try {
        await drainStream(harness, "exhaustion-session");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProviderFallbackExhaustedError);
      const exhausted = thrown as ProviderFallbackExhaustedError;
      // The headline is the USER-SELECTED model's error, not the last fallback's.
      expect(exhausted.message.startsWith("The 'alpha' model is not supported")).toBe(true);
      expect(exhausted.message).toContain(
        "- unit-provider/alpha-mini: The 'alpha-mini' model is not supported",
      );
      expect(exhausted.message).toContain(
        "- unit-provider/gamma: The 'gamma' model is not supported",
      );
      expect(exhausted.retryable).toBe(false);
      expect(exhausted.attempts.map((attempt) => attempt.model)).toEqual([
        "alpha",
        "alpha-mini",
        "gamma",
      ]);
      expect(exhausted.attempts.every((attempt) => attempt.retryable === false)).toBe(true);
      expect((exhausted.cause as Error).message).toBe(
        "The 'alpha' model is not supported for this account.",
      );
      // Every permanently rejected route is remembered on the session face.
      expect([...harness.unavailable.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual([
        "unit-provider/alpha",
        "unit-provider/alpha-mini",
        "unit-provider/gamma",
      ]);
      // The drift metadata carries the failed attempt's message.
      expect(harness.providerFallbacks[0]?.errorSummary).toBe(
        "The 'alpha' model is not supported for this account.",
      );
    } finally {
      unregisterApiProviders(SOURCE_ID);
      clearApiProviders();
    }
  });

  test("fallback walks past a burned top-ranked candidate to the next viable model", async () => {
    clearApiProviders();
    const api = "fallback-walk-test";
    // alpha fails, affinity picks alpha-mini (reliable-fallback token), which also
    // fails. The next round's top affinity pick from alpha-mini is alpha — already
    // attempted. Pre-fix that read as exhaustion; now the walk reaches gamma.
    const harness = createRecoveryHarness({
      api,
      modelIds: ["alpha", "alpha-mini", "gamma"],
      outcomeFor: (modelId) =>
        modelId === "gamma" ? { ok: true } : { ok: false, message: `'${modelId}' rejected` },
    });

    try {
      const frames = await drainStream(harness, "walk-session");
      expect(frames).toEqual([{ type: "text", delta: "ok" }]);
      expect(harness.dialed).toEqual(["alpha", "alpha-mini", "gamma"]);
    } finally {
      unregisterApiProviders(SOURCE_ID);
      clearApiProviders();
    }
  });

  test("a later turn skips models the session already saw rejected permanently", async () => {
    clearApiProviders();
    const api = "fallback-session-memory-test";
    const harness = createRecoveryHarness({
      api,
      modelIds: ["alpha", "alpha-mini", "gamma"],
      outcomeFor: (modelId) =>
        modelId === "gamma" ? { ok: true } : { ok: false, message: `'${modelId}' rejected` },
    });

    try {
      await drainStream(harness, "memory-session-turn-1");
      expect(harness.dialed).toEqual(["alpha", "alpha-mini", "gamma"]);
      expect(harness.unavailable.has("unit-provider/alpha-mini")).toBe(true);

      // Turn 2: the user-selected model is still dialed (entitlement may have
      // changed), but the known-rejected alpha-mini is not re-dialed — fallback
      // goes straight to the model that worked.
      harness.dialed.length = 0;
      const frames = await drainStream(harness, "memory-session-turn-2");
      expect(frames).toEqual([{ type: "text", delta: "ok" }]);
      expect(harness.dialed).toEqual(["alpha", "gamma"]);
    } finally {
      unregisterApiProviders(SOURCE_ID);
      clearApiProviders();
    }
  });
});
