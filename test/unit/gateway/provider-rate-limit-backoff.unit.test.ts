import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import { deterministicJitterFraction } from "@brewva/brewva-vocabulary/schedule";
import { createHostedRuntimeProviderPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-execution-ports.js";
import { createProviderEventStream } from "../../helpers/effect-stream.js";
import { sleep } from "../../helpers/process.js";
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

function rateLimitErrorStream(api: string) {
  return createProviderEventStream([
    {
      type: "error",
      reason: "error",
      error: { ...createMessage(api), stopReason: "error", errorMessage: "rate limit reached" },
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

// The primary model always rate-limits (no frame -> recoverable); the backup succeeds.
function registerPrimaryRateLimitsBackupSucceeds(
  api: string,
  sourceId: string,
): Record<string, number> {
  const attemptsByModel: Record<string, number> = {};
  const handle = (providerModel: { id: string; api: string }) => {
    attemptsByModel[providerModel.id] = (attemptsByModel[providerModel.id] ?? 0) + 1;
    return providerModel.id === "backup"
      ? createProviderEventStream()
      : rateLimitErrorStream(providerModel.api);
  };
  clearApiProviders();
  registerApiProvider(
    {
      api,
      stream() {
        return createProviderEventStream();
      },
      streamSimple(providerModel) {
        return handle(providerModel);
      },
    },
    sourceId,
  );
  return attemptsByModel;
}

function faceWith(
  primary: BrewvaRegisteredModel,
  backup: BrewvaRegisteredModel,
  rateLimitBackoff: { maxRetries: number; baseDelayMs: number; maxDelayMs: number } = {
    maxRetries: 0, // the `normalize` default: off
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
  },
) {
  return createRuntimeProviderFaceFixture({
    model: primary,
    getModelCatalog() {
      return {
        getAll() {
          return [primary, backup];
        },
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "unit-key" };
        },
      };
    },
    getModelRoutingSettings() {
      return {
        fallbackChains: { default: ["unit-provider/backup"] },
        credentialRotation: { enabled: false, cooldownMs: 0 },
        rateLimitBackoff,
      };
    },
  });
}

async function collectFrames(
  provider: ReturnType<typeof createHostedRuntimeProviderPort>,
  sessionId: string,
): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of provider.stream(input(sessionId))) {
    frames.push(frame);
  }
  return frames;
}

// A session id whose first-attempt jitter fraction is high, so a single backoff samples
// well above the abort window in the test below — making the abort land mid-sleep
// deterministically rather than after the wait already elapsed.
function highJitterSession(prefix: string): string {
  for (let n = 0; n < 1_000; n += 1) {
    const sessionId = `${prefix}-${n}`;
    if (deterministicJitterFraction(`${sessionId}:0`) >= 0.5) {
      return sessionId;
    }
  }
  throw new Error("no high-jitter session id found");
}

describe("provider rate-limit backoff", () => {
  test("retries the same model with backoff on rate_limit before falling back", async () => {
    const sourceId = "rate-limit-backoff-on";
    const api = "rate-limit-backoff-on-api";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    const attempts = registerPrimaryRateLimitsBackupSucceeds(api, sourceId);
    try {
      const face = faceWith(primary, backup, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 });
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
      const frames = await collectFrames(
        createHostedRuntimeProviderPort(session as never, face),
        "backoff-on",
      );
      expect(frames).toEqual([]); // backup succeeds with an empty stream
      // 1 initial + 2 backoff retries on the same model, THEN one fallback to backup.
      expect(attempts.primary).toBe(3);
      expect(attempts.backup).toBe(1);
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("does not back off when rateLimitBackoff is absent (default off)", async () => {
    const sourceId = "rate-limit-backoff-off";
    const api = "rate-limit-backoff-off-api";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    const attempts = registerPrimaryRateLimitsBackupSucceeds(api, sourceId);
    try {
      const face = faceWith(primary, backup); // default rateLimitBackoff: maxRetries 0 = off
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
      const frames = await collectFrames(
        createHostedRuntimeProviderPort(session as never, face),
        "backoff-off",
      );
      expect(frames).toEqual([]);
      // No backoff: the primary is tried once, then it falls straight back to backup.
      expect(attempts.primary).toBe(1);
      expect(attempts.backup).toBe(1);
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("aborting during the backoff wait surfaces the error without falling back", async () => {
    const sourceId = "rate-limit-backoff-abort";
    const api = "rate-limit-backoff-abort-api";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    const attempts = registerPrimaryRateLimitsBackupSucceeds(api, sourceId);
    try {
      // A long ceiling so the jittered wait dwarfs the abort delay; the high-jitter
      // session keeps the sampled wait near the ceiling rather than near zero.
      const face = faceWith(primary, backup, {
        maxRetries: 2,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
      });
      const sessionId = highJitterSession("abort");
      const controller = new AbortController();
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
      const provider = createHostedRuntimeProviderPort(session as never, face);
      const base = input(sessionId);
      const drained: unknown[] = [];
      const consume = (async () => {
        for await (const frame of provider.stream({
          ...base,
          turn: { ...base.turn, signal: controller.signal },
        })) {
          drained.push(frame);
        }
      })();
      // Let the loop reach the in-flight backoff sleep, then abort mid-wait.
      await sleep(20);
      controller.abort();
      let settled: "resolved" | "rejected" = "resolved";
      try {
        await consume;
      } catch {
        settled = "rejected";
      }
      // The abort cut the wait: the original error surfaces, the same model was tried
      // exactly once, and the backup was never reached (no key recorded -> zero attempts).
      expect(settled).toBe("rejected");
      expect(attempts.primary).toBe(1);
      expect(attempts.backup ?? 0).toBe(0);
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });
});
