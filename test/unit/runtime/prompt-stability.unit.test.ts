import { describe, expect, test } from "bun:test";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("prompt stability runtime state", () => {
  test("tracks prompt stability transitions and clears on session teardown", () => {
    const runtime = createBrewvaRuntime({
      cwd: createTestWorkspace("prompt-stability-runtime"),
    }).hosted;
    const sessionId = "prompt-stability-runtime-1";

    expect(runtime.inspect.context.prompt.getStability(sessionId)).toBeUndefined();

    const first = runtime.operator.context.prompt.observeStability(sessionId, {
      stablePrefixHash: "prefix-1",
      dynamicTailHash: "tail-1",
      contextScopeId: "leaf-a",
      turn: 1,
      timestamp: 101,
    });
    expect(first).toEqual({
      turn: 1,
      updatedAt: 101,
      scopeKey: "prompt-stability-runtime-1::leaf-a",
      stablePrefixHash: "prefix-1",
      dynamicTailHash: "tail-1",
      stablePrefix: true,
      stableTail: true,
    });

    const unchanged = runtime.operator.context.prompt.observeStability(sessionId, {
      stablePrefixHash: "prefix-1",
      dynamicTailHash: "tail-1",
      contextScopeId: "leaf-a",
      turn: 2,
      timestamp: 102,
    });
    expect(unchanged.stablePrefix).toBe(true);
    expect(unchanged.stableTail).toBe(true);

    const changedPrefix = runtime.operator.context.prompt.observeStability(sessionId, {
      stablePrefixHash: "prefix-2",
      dynamicTailHash: "tail-1",
      contextScopeId: "leaf-a",
      turn: 3,
      timestamp: 103,
    });
    expect(changedPrefix.stablePrefix).toBe(false);
    expect(changedPrefix.stableTail).toBe(true);

    const changedTail = runtime.operator.context.prompt.observeStability(sessionId, {
      stablePrefixHash: "prefix-2",
      dynamicTailHash: "tail-2",
      contextScopeId: "leaf-a",
      turn: 4,
      timestamp: 104,
    });
    expect(changedTail.stablePrefix).toBe(true);
    expect(changedTail.stableTail).toBe(false);

    const changedScope = runtime.operator.context.prompt.observeStability(sessionId, {
      stablePrefixHash: "prefix-3",
      dynamicTailHash: "tail-2",
      contextScopeId: "leaf-b",
      turn: 5,
      timestamp: 105,
    });
    expect(changedScope.scopeKey).toBe("prompt-stability-runtime-1::leaf-b");
    expect(changedScope.stablePrefix).toBe(true);
    expect(changedScope.stableTail).toBe(false);
    expect(runtime.inspect.context.prompt.getStability(sessionId)).toEqual(changedScope);

    runtime.operator.session.state.clear(sessionId);

    expect(runtime.inspect.context.prompt.getStability(sessionId)).toBeUndefined();
  });

  test("tracks transient outbound reduction state and clears on session teardown", () => {
    const runtime = createBrewvaRuntime({
      cwd: createTestWorkspace("transient-reduction-runtime"),
    }).hosted;
    const sessionId = "transient-reduction-runtime-1";

    expect(runtime.inspect.context.prompt.getTransientReduction(sessionId)).toBeUndefined();

    const observed = runtime.operator.context.prompt.observeTransientReduction(sessionId, {
      status: "completed",
      reason: null,
      eligibleToolResults: 6,
      clearedToolResults: 2,
      clearedChars: 2048,
      estimatedTokenSavings: 580,
      compactionAdvised: true,
      forcedCompaction: false,
      turn: 3,
      timestamp: 203,
    });

    expect(observed).toEqual({
      turn: 3,
      updatedAt: 203,
      status: "completed",
      reason: null,
      eligibleToolResults: 6,
      clearedToolResults: 2,
      clearedChars: 2048,
      estimatedTokenSavings: 580,
      compactionAdvised: true,
      forcedCompaction: false,
      classification: null,
      expectedCacheBreak: false,
    });
    expect(runtime.inspect.context.prompt.getTransientReduction(sessionId)).toEqual(observed);

    runtime.operator.session.state.clear(sessionId);

    expect(runtime.inspect.context.prompt.getTransientReduction(sessionId)).toBeUndefined();
  });

  test("tracks provider cache observations and clears on session teardown", () => {
    const runtime = createBrewvaRuntime({
      cwd: createTestWorkspace("provider-cache-runtime"),
    }).hosted;
    const sessionId = "provider-cache-runtime-1";

    expect(runtime.inspect.context.providerCache.getObservation(sessionId)).toBeUndefined();

    const observed = runtime.operator.context.providerCache.observe(sessionId, {
      source: "openai:gpt-5.4:session-1",
      fingerprint: {
        bucketKey:
          "provider=openai|api=openai-responses|model=gpt-5.4|transport=sse|scope=session|retention=short|writeMode=readWrite|session=session-1",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        transport: "sse",
        sessionId: "session-1",
        cachePolicyHash: "policy-1",
        toolSchemaSnapshotHash: "tools-1",
        toolSchemaOverlayHash: "overlay-1",
        perToolHashes: { read: "tool-read-1" },
        stablePrefixHash: "prefix-1",
        dynamicTailHash: "tail-1",
        requestHash: "request-1",
        channelContextHash: "channel-1",
        renderedCacheHash: "render-1",
        cacheCapabilityHash: "capability-1",
        stickyLatchHash: "latch-1",
        reasoningHash: "reasoning-1",
        thinkingBudgetHash: "budget-1",
        cacheRelevantHeadersHash: "headers-1",
        extraBodyHash: "extra-1",
        visibleHistoryReductionHash: "visible-1",
        workbenchContextHash: "recall-1",
        providerFallbackHash: "fallback-1",
      },
      render: {
        status: "rendered",
        reason: "rendered_openai_prompt_cache",
        renderedRetention: "short",
        bucketKey: "openai-responses|session=session-1|retention=short|writeMode=readWrite",
      },
      breakObservation: {
        status: "warm",
        classification: "prefixPreserving",
        expected: false,
        reason: null,
        previousCacheReadTokens: 10_000,
        cacheReadTokens: 9_800,
        cacheWriteTokens: 200,
        cacheMissTokens: 200,
        thresholdTokens: 2_000,
        relativeDropThreshold: 0.05,
        changedFields: [],
      },
      turn: 4,
      timestamp: 404,
    });

    expect(observed).toEqual({
      turn: 4,
      updatedAt: 404,
      source: "openai:gpt-5.4:session-1",
      fingerprint: expect.objectContaining({
        requestHash: "request-1",
        perToolHashes: { read: "tool-read-1" },
      }),
      render: expect.objectContaining({
        status: "rendered",
        reason: "rendered_openai_prompt_cache",
      }),
      breakObservation: expect.objectContaining({
        status: "warm",
        classification: "prefixPreserving",
        expected: false,
      }),
    });
    expect(runtime.inspect.context.providerCache.getObservation(sessionId)).toEqual(observed);

    runtime.operator.session.state.clear(sessionId);

    expect(runtime.inspect.context.providerCache.getObservation(sessionId)).toBeUndefined();
  });

  test("tracks visible read epochs through the runtime context contract", () => {
    const runtime = createBrewvaRuntime({
      cwd: createTestWorkspace("visible-read-runtime"),
    }).hosted;
    const sessionId = "visible-read-runtime-1";

    const initialEpoch = runtime.inspect.context.visibleRead.getEpoch(sessionId);
    expect(initialEpoch).toBe(0);
    const state = {
      path: "/workspace/src/app.ts",
      offset: 0,
      limit: null,
      encoding: "utf8",
      signatureHash: "sig-1",
      visibleHistoryEpoch: initialEpoch,
      previousReadId: "read-1",
    };
    expect(runtime.inspect.context.visibleRead.isCurrent(sessionId, state)).toBe(false);
    runtime.operator.context.visibleRead.rememberState(sessionId, state);
    expect(
      runtime.inspect.context.visibleRead.isCurrent(sessionId, {
        ...state,
        signatureHash: "sig-2",
      }),
    ).toBe(false);
    expect(runtime.inspect.context.visibleRead.isCurrent(sessionId, state)).toBe(true);

    const nextEpoch = runtime.operator.context.visibleRead.advanceEpoch(
      sessionId,
      "history_pruned",
    );

    expect(nextEpoch).toBe(initialEpoch + 1);
    expect(
      runtime.inspect.context.visibleRead.isCurrent(sessionId, {
        path: "/workspace/src/app.ts",
        offset: 0,
        limit: null,
        encoding: "utf8",
        signatureHash: "sig-1",
        visibleHistoryEpoch: initialEpoch,
        previousReadId: "read-1",
      }),
    ).toBe(false);
  });
});
