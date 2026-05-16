import { describe, expect, test } from "bun:test";
import type { ContextBudgetUsage } from "@brewva/brewva-runtime/context";
import { createHostedCompactionController } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-context-telemetry.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

const HIGH_USAGE: ContextBudgetUsage = {
  tokens: 990,
  contextWindow: 1000,
  percent: 0.99,
};

describe("hosted compaction controller", () => {
  test("emits non-interactive skip without exposing an internal trigger ladder", () => {
    const skippedReasons: string[] = [];
    let compactCalls = 0;
    const runtime = createRuntimeFixture({
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
      sessionId: "s-ladder",
      turnIndex: 1,
      timestamp: 10,
    });
    controller.context({
      sessionId: "s-ladder",
      usage: HIGH_USAGE,
      hasUI: false,
      idle: true,
      compact: () => {
        compactCalls += 1;
      },
    });

    expect(compactCalls).toBe(0);
    expect(skippedReasons).toEqual(["non_interactive_mode"]);
  });

  test("deduplicates active-agent auto-compaction skips per pending reason", () => {
    const skippedReasons: string[] = [];
    const runtime = createRuntimeFixture({
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

  test("clears a previously armed runtime gate when session compact completes", async () => {
    const eventTypes: string[] = [];
    const runtime = createRuntimeFixture({
      events: {
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });
    const commitCompactionCalls: Array<Record<string, unknown>> = [];
    const originalCommitCompaction = runtime.authority.session.compaction.commit.bind(
      runtime.authority.session,
    );
    runtime.authority.session.compaction.commit = (sessionId, payload) => {
      commitCompactionCalls.push(payload as unknown as Record<string, unknown>);
      return originalCommitCompaction(sessionId, payload);
    };
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);

    controller.turnStart({
      sessionId: "s-compact",
      turnIndex: 8,
      timestamp: 20,
    });
    controller.context({
      sessionId: "s-compact",
      usage: HIGH_USAGE,
      hasUI: false,
      idle: false,
      compact: undefined,
    });
    await controller.sessionCompact({
      sessionId: "s-compact",
      usage: HIGH_USAGE,
      compactionEntry: {
        id: "cmp-1",
        summary: "Compacted working set",
        firstKeptEntryId: "entry-keep",
      },
      fromExtension: true,
    });

    expect(commitCompactionCalls).toEqual([
      {
        compactId: "cmp-1",
        sanitizedSummary: "Compacted working set",
        summaryDigest: expect.any(String),
        sourceTurn: 0,
        leafEntryId: null,
        firstKeptEntryId: "entry-keep",
        referenceContextDigest: null,
        fromTokens: 990,
        toTokens: 990,
        origin: "extension_api",
        cacheImpact: {
          before: null,
          after: null,
          explicitEpochChanges: 1,
          prefixBytesChanged: null,
          degradedReason: null,
        },
      },
    ]);
    expect(eventTypes).toContain("session_compact");
    expect(eventTypes).toContain("context_compaction_gate_cleared");
  });

  test("opens the auto-compaction breaker after repeated failures and resets it after session compact", async () => {
    let compactCalls = 0;
    const runtime = createRuntimeFixture({});
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

    const skippedBeforeReset = runtime.inspect.events.records
      .queryStructured(sessionId, { type: "context_compaction_skipped" })
      .map((event) => event.payload?.reason);
    expect(compactCalls).toBe(3);
    expect(skippedBeforeReset).toContain("auto_compaction_breaker_open");

    await controller.sessionCompact({
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
    const runtime = createRuntimeFixture({});
    const sessionId = "s-auto-breaker-hydrated";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.extensions.hosted.events.record({
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
      runtime.inspect.events.records
        .queryStructured(sessionId, { type: "context_compaction_skipped" })
        .some((event) => event.payload?.reason === "auto_compaction_breaker_open"),
    ).toBe(true);
  });
});
