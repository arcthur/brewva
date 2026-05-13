import { describe, expect, test } from "bun:test";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaSessionModelDescriptor } from "@brewva/brewva-substrate/session";
import { ManagedSessionCompactionFlowState } from "../../../packages/brewva-gateway/src/hosted/internal/compaction/flow.js";
import {
  requestCompactionAndWait,
  shouldCompactForModelDownshift,
} from "../../../packages/brewva-gateway/src/hosted/internal/compaction/model-downshift-policy.js";

const LARGE_MODEL: BrewvaSessionModelDescriptor = {
  provider: "openai",
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

const SMALL_MODEL: BrewvaSessionModelDescriptor = {
  ...LARGE_MODEL,
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  contextWindow: 32000,
  maxTokens: 4096,
};

function createRuntimeStub(input: {
  tokens?: number;
  recentCompaction?: boolean;
  forcedCompaction?: boolean;
  compactionAdvised?: boolean;
  predictedOverflow?: boolean;
}): BrewvaHostedRuntimePort {
  return {
    inspect: {
      context: {
        usage: {
          get() {
            return typeof input.tokens === "number" ? { tokens: input.tokens } : undefined;
          },
        },
        compaction: {
          getGateStatus() {
            return {
              recentCompaction: input.recentCompaction ?? false,
              status: {
                forcedCompaction: input.forcedCompaction ?? false,
                compactionAdvised: input.compactionAdvised ?? false,
                predictedOverflow: input.predictedOverflow ?? false,
              },
            };
          },
        },
      },
    },
  } as unknown as BrewvaHostedRuntimePort;
}

describe("managed-agent-session compaction flow", () => {
  test("requests compaction for model downshift only when gate status advises it", () => {
    expect(
      shouldCompactForModelDownshift({
        runtime: createRuntimeStub({ tokens: 1000, compactionAdvised: true }),
        sessionId: "sess-1",
        currentModel: LARGE_MODEL,
        targetModel: SMALL_MODEL,
      }),
    ).toBe(true);

    expect(
      shouldCompactForModelDownshift({
        runtime: createRuntimeStub({
          tokens: 1000,
          recentCompaction: true,
          compactionAdvised: true,
        }),
        sessionId: "sess-1",
        currentModel: LARGE_MODEL,
        targetModel: SMALL_MODEL,
      }),
    ).toBe(false);

    expect(
      shouldCompactForModelDownshift({
        runtime: createRuntimeStub({ tokens: 1000, compactionAdvised: true }),
        sessionId: "sess-1",
        currentModel: SMALL_MODEL,
        targetModel: LARGE_MODEL,
      }),
    ).toBe(false);
  });

  test("wraps callback-style compaction requests into a promise", async () => {
    const resolved = await requestCompactionAndWait((request) => {
      request?.onComplete?.({ type: "session_compact", ok: true });
    });
    expect(resolved).toEqual({ type: "session_compact", ok: true });

    try {
      await requestCompactionAndWait((request) => {
        request?.onError?.(new Error("compaction_failed"));
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("compaction_failed");
    }
  });

  test("tracks pending and deferred compaction requests across streaming boundaries", () => {
    const state = new ManagedSessionCompactionFlowState();
    const completed: string[] = [];

    const immediate = state.requestCompaction(false, {
      onComplete: () => completed.push("done"),
    });
    expect(immediate).toBe(true);
    const firstRequest = state.beginDeferredCompaction();
    expect(state.isCompacting).toBe(true);
    expect(firstRequest?.onComplete).toBeDefined();
    state.finishDeferredCompaction();

    const deferred = state.requestCompaction(true, {
      onError: () => completed.push("error"),
    });
    expect(deferred).toBe(false);
    expect(state.consumeToolResultStop([] as never)).toBe(true);
    expect(state.consumeToolResultStop([] as never)).toBe(false);
    expect(state.beginDeferredCompaction()).not.toBeNull();
    state.finishDeferredCompaction();

    expect(completed).toEqual([]);
  });
});
