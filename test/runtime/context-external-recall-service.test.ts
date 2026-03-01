import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { MemoryEngine } from "../../packages/brewva-runtime/src/memory/engine.js";
import {
  recordContextExternalRecallDecision,
  type ContextExternalRecallDeps,
} from "../../packages/brewva-runtime/src/services/context-external-recall.js";
import type { ExternalRecallDecision } from "../../packages/brewva-runtime/src/services/context-memory-injection.js";

describe("context-external-recall module", () => {
  test("records skipped external recall decision", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    const events: Array<{
      sessionId: string;
      type: string;
      payload?: Record<string, unknown>;
    }> = [];
    let writebackCalls = 0;

    const deps: ContextExternalRecallDeps = {
      config,
      memory: {
        ingestExternalRecall: () => {
          writebackCalls += 1;
          return { upserted: 0 };
        },
      } as unknown as MemoryEngine,
      recordEvent: (input) => {
        events.push(input);
        return undefined;
      },
    };

    const decision: ExternalRecallDecision = {
      status: "skipped",
      payload: {
        reason: "provider_unavailable",
        query: "missing provider",
        threshold: 0.62,
      },
    };

    recordContextExternalRecallDecision(deps, "external-recall-skip", "", decision);

    expect(writebackCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("context_external_recall_decision");
    expect(events[0]?.payload).toEqual(
      expect.objectContaining({
        outcome: "skipped",
        reason: "provider_unavailable",
      }),
    );
  });

  test("records filtered_out when accepted recall block is not present in final injection", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    const events: Array<{
      sessionId: string;
      type: string;
      payload?: Record<string, unknown>;
    }> = [];
    let writebackCalls = 0;

    const deps: ContextExternalRecallDeps = {
      config,
      memory: {
        ingestExternalRecall: () => {
          writebackCalls += 1;
          return { upserted: 0 };
        },
      } as unknown as MemoryEngine,
      recordEvent: (input) => {
        events.push(input);
        return undefined;
      },
    };

    const decision: ExternalRecallDecision = {
      status: "accepted",
      outcome: {
        query: "allocator",
        hits: [
          {
            topic: "Allocator",
            excerpt: "external excerpt",
            score: 0.8,
            confidence: 0.7,
          },
        ],
        internalTopScore: 0.2,
        threshold: 0.62,
      },
    };

    recordContextExternalRecallDecision(
      deps,
      "external-recall-filtered",
      "[MemoryRecall]\ninternal only",
      decision,
    );

    expect(writebackCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual(
      expect.objectContaining({
        outcome: "filtered_out",
        reason: "filtered_out",
      }),
    );
  });

  test("writes back and records injected when external block is preserved", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    const events: Array<{
      sessionId: string;
      type: string;
      payload?: Record<string, unknown>;
    }> = [];
    let writebackCalls = 0;

    const deps: ContextExternalRecallDeps = {
      config,
      memory: {
        ingestExternalRecall: () => {
          writebackCalls += 1;
          return { upserted: 2 };
        },
      } as unknown as MemoryEngine,
      recordEvent: (input) => {
        events.push(input);
        return undefined;
      },
    };

    const decision: ExternalRecallDecision = {
      status: "accepted",
      outcome: {
        query: "arena policy",
        hits: [
          {
            topic: "Arena",
            excerpt: "Use bounded compaction.",
            score: 0.91,
            confidence: 0.85,
          },
        ],
        internalTopScore: 0.1,
        threshold: 0.62,
      },
    };

    recordContextExternalRecallDecision(
      deps,
      "external-recall-injected",
      "[ExternalRecall]\nquery: arena policy",
      decision,
    );

    expect(writebackCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual(
      expect.objectContaining({
        outcome: "injected",
        writebackUnits: 2,
      }),
    );
  });
});
