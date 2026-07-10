import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import { deterministicJitterFraction } from "@brewva/brewva-vocabulary/schedule";
import { ManagedSessionRuntimeProviderFace } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/runtime-provider-face.js";
import { createHostedRuntimeProviderPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-execution-ports.js";
import type { RuntimeProviderFace } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-session.js";
import { selectLargerContextModel } from "../../../packages/brewva-gateway/src/policy/model-routing/fallback.js";
import { createProviderEventStream } from "../../helpers/effect-stream.js";
import { createRuntimeProviderFaceFixture } from "../../helpers/runtime-provider-face.js";

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
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function createRuntimeModel(id: string, api: string, contextWindow = 8192): BrewvaRegisteredModel {
  return {
    provider: "unit-provider",
    id,
    name: id,
    api,
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 1024,
  };
}

function errorStream(api: string, message: string) {
  return createProviderEventStream([
    {
      type: "error",
      reason: "error",
      error: { ...createMessage(api), stopReason: "error", errorMessage: message },
    },
  ]);
}

function input(sessionId: string) {
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

function sessionFor(face: RuntimeProviderFace) {
  return {
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
}

async function driveTurn(face: RuntimeProviderFace, sessionId: string): Promise<unknown[]> {
  const provider = createHostedRuntimeProviderPort(sessionFor(face) as never, face);
  const frames: unknown[] = [];
  for await (const frame of provider.stream(input(sessionId))) {
    frames.push(frame);
  }
  return frames;
}

/** Register a provider whose per-model behavior is decided by `respond(id) -> message|null`. */
function registerModelBehavior(
  api: string,
  sourceId: string,
  respond: (id: string) => string | null,
): Record<string, number> {
  const attempts: Record<string, number> = {};
  clearApiProviders();
  registerApiProvider(
    {
      api,
      stream() {
        return createProviderEventStream();
      },
      streamSimple(providerModel: { id: string; api: string }) {
        attempts[providerModel.id] = (attempts[providerModel.id] ?? 0) + 1;
        const message = respond(providerModel.id);
        return message === null
          ? createProviderEventStream()
          : errorStream(providerModel.api, message);
      },
    },
    sourceId,
  );
  return attempts;
}

const RATE_LIMIT = "rate limit reached";
const CONTEXT_OVERFLOW = "maximum allowed input length is 128000 tokens";

function catalogOf(models: BrewvaRegisteredModel[]) {
  return {
    getAll() {
      return models;
    },
    async getApiKeyAndHeaders() {
      return { ok: true as const, apiKey: "unit-key" };
    },
  };
}

/** A session id whose first-attempt jitter fraction is >= 0.5 (used to force a large backoff). */
function highJitterSession(prefix: string): string {
  for (let n = 0; n < 1000; n += 1) {
    const sessionId = `${prefix}-${n}`;
    if (deterministicJitterFraction(`${sessionId}:0`) >= 0.5) {
      return sessionId;
    }
  }
  throw new Error("no high-jitter session id found");
}

describe("selectLargerContextModel", () => {
  const current = createRuntimeModel("mid", "api", 8192);

  test("promotes to the smallest strictly-larger-context sibling", () => {
    const small = createRuntimeModel("small", "api", 4096);
    const big = createRuntimeModel("big", "api", 32000);
    const bigger = createRuntimeModel("bigger", "api", 200000);
    const chosen = selectLargerContextModel({
      currentModel: current,
      availableModels: [small, current, bigger, big],
    });
    expect(chosen?.id).toBe("big");
  });

  test("returns undefined when no sibling has a larger window", () => {
    const small = createRuntimeModel("small", "api", 4096);
    const same = createRuntimeModel("same", "api", 8192);
    const chosen = selectLargerContextModel({
      currentModel: current,
      availableModels: [small, same],
    });
    expect(chosen ?? null).toBeNull();
  });

  test("respects the exclusion set", () => {
    const big = createRuntimeModel("big", "api", 32000);
    const bigger = createRuntimeModel("bigger", "api", 64000);
    const chosen = selectLargerContextModel({
      currentModel: current,
      availableModels: [big, bigger],
      excludeModelKeys: new Set(["unit-provider/big"]),
    });
    expect(chosen?.id).toBe("bigger");
  });

  test("never crosses providers", () => {
    const otherProvider = { ...createRuntimeModel("huge", "api", 500000), provider: "other" };
    const chosen = selectLargerContextModel({
      currentModel: current,
      availableModels: [otherProvider],
    });
    expect(chosen ?? null).toBeNull();
  });
});

describe("context promotion (reason=context)", () => {
  test("promotes to a larger-context sibling before generic fallback", async () => {
    const sourceId = "ctx-promote";
    const api = "ctx-promote-api";
    const primary = createRuntimeModel("primary", api, 8192);
    const big = createRuntimeModel("big", api, 200000);
    // A same-size sibling exists too: promotion must prefer the larger `big`, not this.
    const peer = createRuntimeModel("peer", api, 8192);
    const attempts = registerModelBehavior(api, sourceId, (id) =>
      id === "primary" ? CONTEXT_OVERFLOW : null,
    );
    try {
      const face = createRuntimeProviderFaceFixture({
        model: primary,
        getModelCatalog() {
          return catalogOf([primary, big, peer]);
        },
        getModelRoutingSettings() {
          return {
            fallbackChains: {},
            credentialRotation: { enabled: false, cooldownMs: 0 },
            rateLimitBackoff: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 },
          };
        },
      });
      const frames = await driveTurn(face, "ctx-1");
      expect(frames).toEqual([]);
      expect(attempts.primary).toBe(1);
      expect(attempts.big).toBe(1);
      expect(attempts.peer ?? 0).toBe(0);
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });
});

describe("cross-turn cooldown suppression", () => {
  test("records a cooldown when a rate-limited route is abandoned (backoff configured)", async () => {
    const sourceId = "cooldown-record";
    const api = "cooldown-record-api";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    const suppressed: Array<{ selector: string; untilMs: number }> = [];
    const attempts = registerModelBehavior(api, sourceId, (id) =>
      id === "backup" ? null : RATE_LIMIT,
    );
    try {
      const face = createRuntimeProviderFaceFixture({
        model: primary,
        getModelCatalog() {
          return catalogOf([primary, backup]);
        },
        getModelRoutingSettings() {
          return {
            fallbackChains: { default: ["unit-provider/backup"] },
            credentialRotation: { enabled: false, cooldownMs: 0 },
            rateLimitBackoff: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 60_000 },
          };
        },
        getSuppressedSelectors() {
          return new Map();
        },
        suppressSelector(selector, untilMs) {
          suppressed.push({ selector, untilMs });
        },
      });
      const before = Date.now();
      await driveTurn(face, "cooldown-1");
      const after = Date.now();
      expect(suppressed.map((entry) => entry.selector)).toEqual(["unit-provider/primary"]);
      expect(attempts.backup).toBe(1);
      // The cooldown window is now + rateLimitBackoff.maxDelayMs (60s).
      expect(suppressed[0]?.untilMs).toBeGreaterThanOrEqual(before + 60_000);
      expect(suppressed[0]?.untilMs).toBeLessThanOrEqual(after + 60_000);
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("does not record a cooldown when rate-limit backoff is off (default)", async () => {
    const sourceId = "cooldown-off";
    const api = "cooldown-off-api";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    const suppressed: string[] = [];
    registerModelBehavior(api, sourceId, (id) => (id === "backup" ? null : RATE_LIMIT));
    try {
      const face = createRuntimeProviderFaceFixture({
        model: primary,
        getModelCatalog() {
          return catalogOf([primary, backup]);
        },
        getModelRoutingSettings() {
          return {
            fallbackChains: { default: ["unit-provider/backup"] },
            credentialRotation: { enabled: false, cooldownMs: 0 },
            rateLimitBackoff: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 30_000 },
          };
        },
        getSuppressedSelectors() {
          return new Map();
        },
        suppressSelector(selector) {
          suppressed.push(selector);
        },
      });
      await driveTurn(face, "cooldown-off-1");
      expect(suppressed).toEqual([]);
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("skips a cooling primary at turn start and begins on a fallback", async () => {
    const sourceId = "cooldown-skip";
    const api = "cooldown-skip-api";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    // Primary would rate-limit if dialed; the start-skip must avoid dialing it.
    const attempts = registerModelBehavior(api, sourceId, (id) =>
      id === "backup" ? null : RATE_LIMIT,
    );
    try {
      const face = createRuntimeProviderFaceFixture({
        model: primary,
        getModelCatalog() {
          return catalogOf([primary, backup]);
        },
        getModelRoutingSettings() {
          return {
            fallbackChains: { default: ["unit-provider/backup"] },
            credentialRotation: { enabled: false, cooldownMs: 0 },
            rateLimitBackoff: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 60_000 },
          };
        },
        getSuppressedSelectors(now) {
          return new Map([["unit-provider/primary", now + 60_000]]);
        },
      });
      const frames = await driveTurn(face, "cooldown-skip-1");
      expect(frames).toEqual([]);
      expect(attempts.primary ?? 0).toBe(0);
      expect(attempts.backup).toBe(1);
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });
});

describe("fail-fast retry cap", () => {
  test("skips a backoff wait that exceeds the retry ceiling and falls back immediately", async () => {
    const sourceId = "failfast-cap";
    const api = "failfast-cap-api";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    const attempts = registerModelBehavior(api, sourceId, (id) =>
      id === "backup" ? null : RATE_LIMIT,
    );
    try {
      // Backoff is ON (maxRetries 2) with a 200s ceiling, but the overall retry
      // cap is 60s. A high-jitter session samples the first backoff near the
      // ceiling (>60s), so the cap fires: no sleep, straight to fallback. If the
      // cap did not fire the test would hang on a ~100s+ sleep.
      const face = createRuntimeProviderFaceFixture({
        model: primary,
        getModelCatalog() {
          return catalogOf([primary, backup]);
        },
        getRetrySettings() {
          return { maxDelayMs: 60_000 };
        },
        getModelRoutingSettings() {
          return {
            fallbackChains: { default: ["unit-provider/backup"] },
            credentialRotation: { enabled: false, cooldownMs: 0 },
            rateLimitBackoff: { maxRetries: 2, baseDelayMs: 200_000, maxDelayMs: 200_000 },
          };
        },
      });
      const frames = await driveTurn(face, highJitterSession("failfast"));
      expect(frames).toEqual([]);
      // maxRetries=2 would give primary=3 without the cap; the cap collapses it to 1.
      expect(attempts.primary).toBe(1);
      expect(attempts.backup).toBe(1);
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });
});

describe("ManagedSessionRuntimeProviderFace cooldown store", () => {
  // The recovery loop stubs the face in the integration tests above; this exercises
  // the concrete suppress/getSuppressed logic (the stranding-safety-critical bits)
  // directly with an explicit clock.
  function makeFace(retryMaxDelayMs = 42) {
    return new ManagedSessionRuntimeProviderFace({
      settings: { getRetrySettings: () => ({ maxDelayMs: retryMaxDelayMs }) } as never,
      catalog: {} as never,
      runtime: {} as never,
      getSessionId: () => "s",
      verificationGateManifests: [],
      getModel: () => undefined,
      getModelPresetState: () => ({
        activeName: "default",
        defaultName: "default",
        presets: [{ name: "default", roles: {} }],
      }),
    });
  }

  test("lazily sweeps a selector once its expiry passes", () => {
    const face = makeFace();
    face.suppressSelector("m1", 100);
    expect([...face.getSuppressedSelectors(50).keys()]).toEqual(["m1"]);
    // untilMs <= now → swept (so an expired cooldown never strands on a fallback).
    expect([...face.getSuppressedSelectors(100).keys()]).toEqual([]);
    expect([...face.getSuppressedSelectors(150).keys()]).toEqual([]);
  });

  test("keeps the later expiry when a cooling selector is re-suppressed", () => {
    const face = makeFace();
    face.suppressSelector("m2", 200);
    face.suppressSelector("m2", 100); // earlier → ignored
    expect(face.getSuppressedSelectors(150).get("m2")).toBe(200);
    face.suppressSelector("m2", 300); // later → replaces
    expect(face.getSuppressedSelectors(250).get("m2")).toBe(300);
  });

  test("delegates getRetrySettings to the settings port", () => {
    expect(makeFace(60_000).getRetrySettings()?.maxDelayMs).toBe(60_000);
  });
});
