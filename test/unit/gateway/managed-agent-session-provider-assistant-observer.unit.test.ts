import { describe, expect, test } from "bun:test";
import { ManagedSessionProviderAssistantObserver } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/provider-assistant-observer.js";

function buildCacheBreakDetector(onObserve?: () => void) {
  return {
    observe: () => {
      onObserve?.();
      return {
        status: "expected",
        classification: "expected",
        expected: true,
        reason: "missing_state",
        source: "bucket",
        observedAt: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thresholdTokens: 0,
        relativeDropThreshold: 0,
        fingerprintDriftKeys: [],
      } as never;
    },
  };
}

function buildRuntimeSpy() {
  const costRecords: unknown[] = [];
  const usageRecords: unknown[] = [];
  const runtime = {
    ops: {
      cost: {
        usage: {
          recordAssistant: (input: unknown) => {
            costRecords.push(input);
            return {} as never;
          },
        },
      },
      context: {
        usage: {
          observe: (_sessionId: string, payload: unknown) => {
            usageRecords.push(payload);
            return undefined;
          },
        },
      },
    },
  } as never;
  return { runtime, costRecords, usageRecords };
}

function assistantMessage(usage: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage,
    stopReason: "stop",
    timestamp: 1,
  } as never;
}

describe("managed-agent-session provider assistant observer", () => {
  test("skips observation when runtime fingerprint state is incomplete", () => {
    let observed = 0;
    const observer = new ManagedSessionProviderAssistantObserver({
      runtime: undefined,
      sessionId: "sess-1",
      cacheBreakDetector: buildCacheBreakDetector(() => {
        observed += 1;
      }),
      resolveExpectedBreak: () => undefined,
      state: () => ({
        lastProviderFingerprint: undefined,
        lastCacheRender: undefined,
        lastToolSchemaEstimatedTokens: undefined,
      }),
    });

    observer.onCommittedAssistantMessage(assistantMessage({}));

    expect(observed).toBe(0);
  });

  test("records cost and context usage for attempt-committed assistant messages", () => {
    const { runtime, costRecords, usageRecords } = buildRuntimeSpy();
    const observer = new ManagedSessionProviderAssistantObserver({
      runtime,
      sessionId: "sess-2",
      cacheBreakDetector: buildCacheBreakDetector(),
      resolveExpectedBreak: () => undefined,
      state: () =>
        ({
          lastProviderFingerprint: { bucketKey: "bucket" },
          lastCacheRender: undefined,
          lastToolSchemaEstimatedTokens: undefined,
        }) as never,
      resolveContextWindow: () => 200_000,
    });

    observer.onCommittedAssistantMessage(
      assistantMessage({
        input: 1_000,
        output: 250,
        cacheRead: 8_000,
        cacheWrite: 0,
        totalTokens: 9_250,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
      }),
    );

    expect(costRecords).toHaveLength(1);
    expect(costRecords[0]).toMatchObject({
      sessionId: "sess-2",
      input: 1_000,
      output: 250,
      cacheRead: 8_000,
      totalTokens: 9_250,
      model: "openai-codex/gpt-5.5",
    });
    expect(usageRecords).toHaveLength(1);
    expect(usageRecords[0]).toMatchObject({ tokens: 9_250, contextWindow: 200_000 });
  });

  test("records nothing for replayed messages or empty usage", () => {
    const { runtime, costRecords, usageRecords } = buildRuntimeSpy();
    const stateWithFingerprint = {
      lastProviderFingerprint: { bucketKey: "bucket" },
      lastCacheRender: undefined,
      lastToolSchemaEstimatedTokens: undefined,
    } as never;

    const replayObserver = new ManagedSessionProviderAssistantObserver({
      runtime,
      sessionId: "sess-3",
      cacheBreakDetector: buildCacheBreakDetector(),
      resolveExpectedBreak: () => undefined,
      // No provider fingerprint yet: bootstrap/history replay.
      state: () => ({
        lastProviderFingerprint: undefined,
        lastCacheRender: undefined,
        lastToolSchemaEstimatedTokens: undefined,
      }),
      resolveContextWindow: () => 200_000,
    });
    replayObserver.onCommittedAssistantMessage(
      assistantMessage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
    );

    const emptyUsageObserver = new ManagedSessionProviderAssistantObserver({
      runtime,
      sessionId: "sess-3",
      cacheBreakDetector: buildCacheBreakDetector(),
      resolveExpectedBreak: () => undefined,
      state: () => stateWithFingerprint,
      resolveContextWindow: () => 200_000,
    });
    emptyUsageObserver.onCommittedAssistantMessage(assistantMessage({}));

    expect(costRecords).toHaveLength(0);
    expect(usageRecords).toHaveLength(0);
  });

  test("records a marked output estimate for live messages when the provider omits usage", () => {
    const { runtime, costRecords, usageRecords } = buildRuntimeSpy();
    const observer = new ManagedSessionProviderAssistantObserver({
      runtime,
      sessionId: "sess-estimate",
      cacheBreakDetector: buildCacheBreakDetector(),
      resolveExpectedBreak: () => undefined,
      state: () =>
        ({
          lastProviderFingerprint: { bucketKey: "bucket" },
          lastCacheRender: undefined,
          lastToolSchemaEstimatedTokens: undefined,
        }) as never,
      resolveContextWindow: () => 200_000,
      usageEstimationEnabled: () => true,
    });

    const message = assistantMessage({}) as { content: unknown };
    message.content = [{ type: "text", text: "A committed answer long enough to count tokens." }];
    observer.onCommittedAssistantMessage(message as never);

    expect(costRecords).toHaveLength(1);
    expect(costRecords[0]).toMatchObject({
      sessionId: "sess-estimate",
      estimated: true,
      model: "openai-codex/gpt-5.5",
    });
    const record = costRecords[0] as { output: number; totalTokens: number };
    expect(record.output).toBeGreaterThan(0);
    expect(record.totalTokens).toBe(record.output);
    // Estimation never fabricates a context-usage observation.
    expect(usageRecords).toHaveLength(0);
  });

  test("never estimates failed or aborted attempts, and stays off when not enabled", () => {
    const { runtime, costRecords } = buildRuntimeSpy();
    const makeObserver = (enabled: boolean) =>
      new ManagedSessionProviderAssistantObserver({
        runtime,
        sessionId: "sess-estimate-gates",
        cacheBreakDetector: buildCacheBreakDetector(),
        resolveExpectedBreak: () => undefined,
        state: () =>
          ({
            lastProviderFingerprint: { bucketKey: "bucket" },
            lastCacheRender: undefined,
            lastToolSchemaEstimatedTokens: undefined,
          }) as never,
        resolveContextWindow: () => 200_000,
        ...(enabled ? { usageEstimationEnabled: () => true } : {}),
      });

    // A failed attempt carries partial content with zeroed counters: N
    // retries must not commit N phantom estimated receipts.
    const failed = assistantMessage({}) as { content: unknown; stopReason: string };
    failed.content = [{ type: "text", text: "partial content before the stream error" }];
    failed.stopReason = "error";
    makeObserver(true).onCommittedAssistantMessage(failed as never);
    expect(costRecords).toHaveLength(0);

    // Without the injected enable signal the estimation path stays closed.
    const complete = assistantMessage({}) as { content: unknown };
    complete.content = [{ type: "text", text: "a completed answer" }];
    makeObserver(false).onCommittedAssistantMessage(complete as never);
    expect(costRecords).toHaveLength(0);
  });

  test("skips context usage when no context window is known", () => {
    const { runtime, costRecords, usageRecords } = buildRuntimeSpy();
    const observer = new ManagedSessionProviderAssistantObserver({
      runtime,
      sessionId: "sess-4",
      cacheBreakDetector: buildCacheBreakDetector(),
      resolveExpectedBreak: () => undefined,
      state: () =>
        ({
          lastProviderFingerprint: { bucketKey: "bucket" },
          lastCacheRender: undefined,
          lastToolSchemaEstimatedTokens: undefined,
        }) as never,
      resolveContextWindow: () => null,
    });

    observer.onCommittedAssistantMessage(
      assistantMessage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
    );

    expect(costRecords).toHaveLength(1);
    expect(usageRecords).toHaveLength(0);
  });
});
