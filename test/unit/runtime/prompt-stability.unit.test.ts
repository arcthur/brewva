import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("prompt stability runtime state", () => {
  test("tracks prompt stability transitions and clears on session teardown", () => {
    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("prompt-stability-runtime") });
    const sessionId = "prompt-stability-runtime-1";

    expect(runtime.inspect.context.getPromptStability(sessionId)).toBeUndefined();

    const first = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-1",
      dynamicTailHash: "tail-1",
      injectionScopeId: "leaf-a",
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

    const unchanged = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-1",
      dynamicTailHash: "tail-1",
      injectionScopeId: "leaf-a",
      turn: 2,
      timestamp: 102,
    });
    expect(unchanged.stablePrefix).toBe(true);
    expect(unchanged.stableTail).toBe(true);

    const changedPrefix = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-2",
      dynamicTailHash: "tail-1",
      injectionScopeId: "leaf-a",
      turn: 3,
      timestamp: 103,
    });
    expect(changedPrefix.stablePrefix).toBe(false);
    expect(changedPrefix.stableTail).toBe(true);

    const changedTail = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-2",
      dynamicTailHash: "tail-2",
      injectionScopeId: "leaf-a",
      turn: 4,
      timestamp: 104,
    });
    expect(changedTail.stablePrefix).toBe(true);
    expect(changedTail.stableTail).toBe(false);

    const changedScope = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-3",
      dynamicTailHash: "tail-2",
      injectionScopeId: "leaf-b",
      turn: 5,
      timestamp: 105,
    });
    expect(changedScope.scopeKey).toBe("prompt-stability-runtime-1::leaf-b");
    expect(changedScope.stablePrefix).toBe(true);
    expect(changedScope.stableTail).toBe(false);
    expect(runtime.inspect.context.getPromptStability(sessionId)).toEqual(changedScope);

    runtime.maintain.session.clearState(sessionId);

    expect(runtime.inspect.context.getPromptStability(sessionId)).toBeUndefined();
  });

  test("tracks transient outbound reduction state and clears on session teardown", () => {
    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("transient-reduction-runtime") });
    const sessionId = "transient-reduction-runtime-1";

    expect(runtime.inspect.context.getTransientReduction(sessionId)).toBeUndefined();

    const observed = runtime.maintain.context.observeTransientReduction(sessionId, {
      status: "completed",
      reason: null,
      eligibleToolResults: 6,
      clearedToolResults: 2,
      clearedChars: 2048,
      estimatedTokenSavings: 580,
      pressureLevel: "high",
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
      pressureLevel: "high",
    });
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(observed);

    runtime.maintain.session.clearState(sessionId);

    expect(runtime.inspect.context.getTransientReduction(sessionId)).toBeUndefined();
  });
});
