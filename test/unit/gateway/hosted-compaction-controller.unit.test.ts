import { describe, expect, test } from "bun:test";
import type { ContextBudgetUsage } from "@brewva/brewva-runtime";
import { createHostedCompactionController } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-compaction-controller.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

const HIGH_USAGE: ContextBudgetUsage = {
  tokens: 990,
  contextWindow: 1000,
  percent: 0.99,
};

describe("hosted compaction controller", () => {
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
});
