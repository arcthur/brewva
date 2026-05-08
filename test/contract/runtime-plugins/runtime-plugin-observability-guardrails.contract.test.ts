import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextEvidenceReport,
  recordPromptStabilityEvidence,
  recordTransientReductionEvidence,
  registerEventStream,
} from "@brewva/brewva-gateway/runtime-plugins";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { requireNumber, requireRecord } from "../../helpers/assertions.js";
import {
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
} from "../../helpers/prompt-session-events.js";
import { createMockRuntimePluginApi, invokeHandlers } from "../../helpers/runtime-plugin.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";

describe("Runtime plugin integration: observability guardrails", () => {
  test("given assistant delta events, when the message completes, then only the durable message_end summary is persisted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-throttle-"));
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "ext-throttle-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "message_start", { message: { role: "assistant", content: [] } }, ctx);
    invokeHandlers(
      handlers,
      "message_update",
      createPromptMessageUpdateEvent({
        message: { role: "assistant", content: [{ type: "text", text: "a" }] },
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: "a",
          partial: { role: "assistant", content: [{ type: "text", text: "a" }] },
        }),
      }),
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_update",
      createPromptMessageUpdateEvent({
        message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: "b",
          partial: { role: "assistant", content: [{ type: "text", text: "ab" }] },
        }),
      }),
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_update",
      createPromptMessageUpdateEvent({
        message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: "c",
          partial: { role: "assistant", content: [{ type: "text", text: "abc" }] },
        }),
      }),
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_end",
      {
        message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
      },
      ctx,
    );

    expect(runtime.inspect.events.query(sessionId, { type: "message_update" })).toHaveLength(0);
    const ends = runtime.inspect.events.query(sessionId, { type: "message_end" });
    expect(ends).toHaveLength(1);
    const payload = ends[0]?.payload as {
      health?: { score?: number; windowChars?: number };
      usage?: { cacheReadReported?: boolean; cacheWriteReported?: boolean } | null;
    };
    const health = requireRecord(payload.health, "Expected message_end health summary.") as {
      score?: unknown;
      windowChars?: unknown;
    };
    requireNumber(health.score, "Expected numeric health.score.");
    expect(health.windowChars).toBe(3);
    expect(payload.usage).toBeNull();
  });

  test("given assistant partial-only update events, when the message completes, then health tracking still uses the partial payload", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-throttle-partial-only-"));
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "ext-throttle-partial-only-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "message_start", { message: { role: "assistant", content: [] } }, ctx);
    invokeHandlers(
      handlers,
      "message_update",
      createPromptMessageUpdateEvent({
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: "a",
          partial: { role: "assistant", content: [{ type: "text", text: "a" }] },
        }),
      }),
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_update",
      createPromptMessageUpdateEvent({
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: "b",
          partial: { role: "assistant", content: [{ type: "text", text: "ab" }] },
        }),
      }),
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_update",
      createPromptMessageUpdateEvent({
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: "c",
          partial: { role: "assistant", content: [{ type: "text", text: "abc" }] },
        }),
      }),
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_end",
      {
        message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
      },
      ctx,
    );

    const ends = runtime.inspect.events.query(sessionId, { type: "message_end" });
    expect(ends).toHaveLength(1);
    const payload = ends[0]?.payload as {
      health?: { score?: number; windowChars?: number };
    };
    const health = requireRecord(payload.health, "Expected message_end health summary.") as {
      windowChars?: unknown;
    };
    expect(health.windowChars).toBe(3);
  });

  test("given the ledger directory disappears before message_end, when assistant usage is recorded, then event stream recreates the ledger path", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-message-ledger-recovery-"));
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "ext-message-ledger-recovery-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    rmSync(join(workspace, ".orchestrator", "ledger"), {
      recursive: true,
      force: true,
    });

    invokeHandlers(
      handlers,
      "message_end",
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "end_turn",
          usage: {
            input: 12,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20,
            cost: {
              total: 0.00012,
            },
          },
          content: [{ type: "text", text: "done" }],
        },
      },
      ctx,
    );

    expect(existsSync(join(workspace, ".orchestrator", "ledger", "evidence.jsonl"))).toBe(true);
    const messageEnds = runtime.inspect.events.query(sessionId, { type: "message_end" });
    expect(messageEnds).toHaveLength(1);
    expect(messageEnds[0]?.payload).toMatchObject({
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cacheReadReported: true,
        cacheWriteReported: true,
      },
    });
    expect(runtime.inspect.events.query(sessionId, { type: "cost_update" })).toHaveLength(1);
    const ledgerRows = runtime.inspect.ledger.listRows(sessionId);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.tool).toBe("brewva_cost");
  });

  test("given event-stream message_end usage and sidecar evidence, when building the context evidence report, then readiness reflects explicit provider cache accounting", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-context-evidence-"));
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "ext-context-evidence-1";

    const prompt = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-live",
      dynamicTailHash: "tail-live",
      contextScopeId: "leaf-live",
      turn: 1,
      timestamp: 1_740_000_003_100,
    });
    recordPromptStabilityEvidence({
      workspaceRoot: runtime.workspaceRoot,
      sessionId,
      observed: prompt,
      compactionAdvised: true,
      forcedCompaction: false,
      usageRatio: 0.9,
      pendingCompactionReason: "usage_threshold",
      gateRequired: false,
    });

    const reduction = runtime.maintain.context.observeTransientReduction(sessionId, {
      status: "completed",
      reason: null,
      eligibleToolResults: 4,
      clearedToolResults: 2,
      clearedChars: 1536,
      estimatedTokenSavings: 410,
      compactionAdvised: true,
      forcedCompaction: false,
      turn: 1,
      timestamp: 1_740_000_003_110,
    });
    recordTransientReductionEvidence({
      workspaceRoot: runtime.workspaceRoot,
      sessionId,
      observed: reduction,
    });

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    invokeHandlers(
      handlers,
      "message_end",
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "end_turn",
          usage: {
            input: 18,
            output: 6,
            cacheRead: 40,
            cacheWrite: 9,
            totalTokens: 73,
            cost: {
              total: 0.0002,
            },
          },
          content: [{ type: "text", text: "cached response" }],
        },
      },
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    const messageEnds = runtime.inspect.events.query(sessionId, { type: "message_end" });
    expect(messageEnds).toHaveLength(1);
    expect(messageEnds[0]?.payload).toMatchObject({
      usage: {
        cacheRead: 40,
        cacheWrite: 9,
        cacheReadReported: true,
        cacheWriteReported: true,
      },
    });

    const report = buildContextEvidenceReport(runtime, {
      sessionIds: [sessionId],
    });
    expect(report.aggregate).toMatchObject({
      sessionsObserved: 1,
      promptObservedTurns: 1,
      stablePrefixTurns: 1,
      reductionObservedTurns: 1,
      reductionCompletedTurns: 1,
      totalEstimatedTokenSavings: 410,
      totalCacheReadTokens: 40,
      totalCacheWriteTokens: 9,
      sessionsWithReportedCacheRead: 1,
      sessionsWithReportedCacheWrite: 1,
      sessionsWithObservedCacheAccounting: 1,
    });
    expect(report.promotionReadiness).toEqual({
      stablePrefixTargetMet: true,
      reductionEvidenceObserved: true,
      cacheAccountingObserved: true,
      promptCacheHitTargetMet: true,
      promptCacheStopLossPassed: true,
      inputCostBaselineObserved: false,
      inputCostStopLossPassed: true,
      ready: true,
      gaps: [],
    });
    expect(report.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        cacheReadTokens: 40,
        cacheWriteTokens: 9,
        cacheReadReported: true,
        cacheWriteReported: true,
        cacheAccountingObserved: true,
        reductionCompletedTurns: 1,
      }),
    ]);
  });
});
