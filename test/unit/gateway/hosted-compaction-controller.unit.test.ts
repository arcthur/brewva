import { describe, expect, test } from "bun:test";
import type { ContextBudgetUsage } from "@brewva/brewva-runtime";
import {
  HOSTED_COMPACTION_LADDER_TEST_ONLY,
  createHostedCompactionController,
} from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-compaction-controller.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

const HIGH_USAGE: ContextBudgetUsage = {
  tokens: 990,
  contextWindow: 1000,
  percent: 0.99,
};

describe("hosted compaction controller", () => {
  test("resolves the compaction ladder in deterministic-first order", () => {
    const runtime = createRuntimeFixture({
      context: {
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
      },
    });

    const baseState = {
      hydrated: true,
      turnIndex: 1,
      lastRuntimeGateRequired: false,
      autoCompactionInFlight: false,
      autoCompactionWatchdog: null,
      autoCompactionAttemptId: 0,
      activeAutoCompactionAttemptId: null,
      autoCompactionConsecutiveFailures: 0,
      autoCompactionBreakerOpen: false,
      autoCompactionBreakerSkipReason: null,
      deferredAutoCompactionReason: null,
    };

    expect(
      HOSTED_COMPACTION_LADDER_TEST_ONLY.resolveCompactionLadderDecision({
        runtime,
        sessionId: "s-ladder",
        usage: HIGH_USAGE,
        hasUI: false,
        idle: true,
        state: baseState,
      }).step,
    ).toBe("non_interactive_mode");
    expect(
      HOSTED_COMPACTION_LADDER_TEST_ONLY.resolveCompactionLadderDecision({
        runtime,
        sessionId: "s-ladder",
        usage: HIGH_USAGE,
        hasUI: true,
        idle: false,
        state: baseState,
      }).step,
    ).toBe("agent_active_manual_compaction_unsafe");
    expect(
      HOSTED_COMPACTION_LADDER_TEST_ONLY.resolveCompactionLadderDecision({
        runtime,
        sessionId: "s-ladder",
        usage: HIGH_USAGE,
        hasUI: true,
        idle: true,
        state: {
          ...baseState,
          autoCompactionBreakerOpen: true,
        },
      }).step,
    ).toBe("auto_compaction_breaker_open");
    expect(
      HOSTED_COMPACTION_LADDER_TEST_ONLY.resolveCompactionLadderDecision({
        runtime,
        sessionId: "s-ladder",
        usage: HIGH_USAGE,
        hasUI: true,
        idle: true,
        state: {
          ...baseState,
          autoCompactionInFlight: true,
        },
      }).step,
    ).toBe("auto_compaction_in_flight");
    expect(
      HOSTED_COMPACTION_LADDER_TEST_ONLY.resolveCompactionLadderDecision({
        runtime,
        sessionId: "s-ladder",
        usage: HIGH_USAGE,
        hasUI: true,
        idle: true,
        state: baseState,
      }).step,
    ).toBe("execute_auto_compaction");
  });

  test("deduplicates active-agent auto-compaction skips per pending reason", () => {
    const skippedReasons: string[] = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
      },
      events: {
        record: (input: { type: string; payload?: { reason?: string } }) => {
          if (input.type === "context_compaction_skipped" && input.payload?.reason) {
            skippedReasons.push(input.payload.reason);
          }
          return undefined;
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);

    controller.turnStart({
      sessionId: "s-busy",
      turnIndex: 4,
      timestamp: 10,
    });
    controller.context({
      sessionId: "s-busy",
      usage: HIGH_USAGE,
      hasUI: true,
      idle: false,
      compact: undefined,
    });
    controller.context({
      sessionId: "s-busy",
      usage: HIGH_USAGE,
      hasUI: true,
      idle: false,
      compact: undefined,
    });

    expect(skippedReasons).toEqual(["agent_active_manual_compaction_unsafe"]);
  });

  test("clears a previously armed runtime gate when session compact completes", () => {
    const eventTypes: string[] = [];
    const markCompactedCalls: Array<Record<string, unknown>> = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        markCompacted: (_sessionId, payload) => {
          markCompactedCalls.push(payload as Record<string, unknown>);
        },
      },
      events: {
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);

    controller.turnStart({
      sessionId: "s-compact",
      turnIndex: 8,
      timestamp: 20,
    });
    controller.setLastRuntimeGateRequired("s-compact", true);
    controller.sessionCompact({
      sessionId: "s-compact",
      usage: HIGH_USAGE,
      compactionEntry: {
        id: "cmp-1",
        summary: "Compacted working set",
      },
      fromExtension: true,
    });

    expect(markCompactedCalls).toEqual([
      {
        fromTokens: null,
        toTokens: 990,
        summary: "Compacted working set",
        entryId: "cmp-1",
      },
    ]);
    expect(eventTypes).toContain("session_compact");
    expect(eventTypes).toContain("context_compaction_gate_cleared");
  });

  test("opens the auto-compaction breaker after repeated failures and resets it after session compact", () => {
    let compactCalls = 0;
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
        markCompacted: () => undefined,
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);
    const sessionId = "s-auto-breaker";

    controller.turnStart({
      sessionId,
      turnIndex: 3,
      timestamp: 30,
    });

    const failCompact = () => {
      compactCalls += 1;
      return {
        customInstructions: undefined,
      };
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      controller.context({
        sessionId,
        usage: HIGH_USAGE,
        hasUI: true,
        idle: true,
        compact: ({ onError }) => {
          failCompact();
          onError?.(new Error("auto_failed"));
        },
      });
    }

    controller.context({
      sessionId,
      usage: HIGH_USAGE,
      hasUI: true,
      idle: true,
      compact: () => {
        compactCalls += 1;
      },
    });

    const skippedBeforeReset = runtime.events
      .queryStructured(sessionId, { type: "context_compaction_skipped" })
      .map((event) => event.payload?.reason);
    expect(compactCalls).toBe(3);
    expect(skippedBeforeReset).toContain("auto_compaction_breaker_open");

    controller.sessionCompact({
      sessionId,
      usage: HIGH_USAGE,
      compactionEntry: {
        id: "cmp-reset",
        summary: "Reset breaker",
      },
      fromExtension: true,
    });

    controller.context({
      sessionId,
      usage: HIGH_USAGE,
      hasUI: true,
      idle: true,
      compact: () => {
        compactCalls += 1;
      },
    });

    expect(compactCalls).toBe(4);
  });

  test("rehydrates an open auto-compaction breaker from durable telemetry", () => {
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
      },
    });
    const sessionId = "s-auto-breaker-hydrated";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.events.record({
        sessionId,
        type: "context_compaction_auto_failed",
        payload: {
          reason: "usage_threshold",
          error: "auto_failed",
        },
      });
    }

    let compactCalls = 0;
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);
    controller.turnStart({
      sessionId,
      turnIndex: 7,
      timestamp: 70,
    });
    controller.context({
      sessionId,
      usage: HIGH_USAGE,
      hasUI: true,
      idle: true,
      compact: () => {
        compactCalls += 1;
      },
    });

    expect(compactCalls).toBe(0);
    expect(
      runtime.events
        .queryStructured(sessionId, { type: "context_compaction_skipped" })
        .some((event) => event.payload?.reason === "auto_compaction_breaker_open"),
    ).toBe(true);
  });
});
