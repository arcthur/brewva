import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import { createHostedRuntimeProviderPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-execution-ports.js";
import { createProviderEventStream } from "../../helpers/effect-stream.js";
import { createRuntimeProviderFaceFixture } from "../../helpers/runtime-provider-face.js";

const SOURCE_ID = "provider-retryable-propagation-unit-test";

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
    stopReason: "error",
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

function createSession(providerFace: ReturnType<typeof createRuntimeProviderFaceFixture>) {
  return {
    getRegisteredTools() {
      return [];
    },
    getRuntimeProviderFace() {
      return providerFace;
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

function createInput(sessionId: string) {
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

async function streamThrows(sessionId: string, retryable: boolean | undefined): Promise<unknown> {
  const api = `${SOURCE_ID}-${sessionId}`;
  const model = createRuntimeModel("primary", api);
  clearApiProviders();
  registerApiProvider(
    {
      api,
      stream() {
        return createProviderEventStream();
      },
      streamSimple(providerModel) {
        const partial = createMessage(providerModel.api);
        return createProviderEventStream([
          {
            type: "error",
            reason: "error",
            error: { ...partial, stopReason: "error", errorMessage: "model not entitled" },
            ...(retryable === undefined ? {} : { retryable }),
          },
        ]);
      },
    },
    SOURCE_ID,
  );
  const providerFace = createRuntimeProviderFaceFixture({
    model,
    getModelCatalog() {
      return {
        getAll() {
          return [model];
        },
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "unit-key" };
        },
      };
    },
    getModelRoutingSettings() {
      return {
        fallbackChains: {},
        credentialRotation: { enabled: false, cooldownMs: 5_000 },
        rateLimitBackoff: { maxRetries: 0, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      };
    },
  });
  const provider = createHostedRuntimeProviderPort(
    createSession(providerFace) as never,
    providerFace,
  );
  try {
    for await (const frame of provider.stream(createInput(sessionId))) {
      void frame;
    }
    return undefined;
  } catch (error) {
    return error;
  } finally {
    unregisterApiProviders(SOURCE_ID);
    clearApiProviders();
  }
}

describe("hosted provider port retryable propagation", () => {
  test("carries retryable:false from the error event onto the thrown error", async () => {
    const thrown = await streamThrows("nonretryable", false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { retryable?: boolean }).retryable).toBe(false);
  });

  test("leaves retryable undefined when the error event does not classify it", async () => {
    const thrown = await streamThrows("unclassified", undefined);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { retryable?: boolean }).retryable).toBe(undefined);
  });
});
