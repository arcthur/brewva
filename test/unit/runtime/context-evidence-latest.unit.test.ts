import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG, createBrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("context evidence latest inspect surface", () => {
  test("keeps only lossy in-memory latest evidence per kind", () => {
    const workspace = createTestWorkspace("context-evidence-latest");
    const sessionId = "session-evidence";
    const firstRuntime = createBrewvaRuntime({
      cwd: workspace,
      config: DEFAULT_BREWVA_CONFIG,
    }).hosted;

    firstRuntime.operator.context.evidence.append(sessionId, {
      kind: "prompt_stability",
      turn: 1,
      timestamp: 10,
      payload: {
        scopeKey: "session-evidence::root",
        stablePrefixHash: "prefix-a",
        dynamicTailHash: "tail-a",
        stablePrefix: true,
        stableTail: true,
      },
    });
    firstRuntime.operator.context.evidence.append(sessionId, {
      kind: "prompt_stability",
      turn: 2,
      timestamp: 20,
      payload: {
        scopeKey: "session-evidence::root",
        stablePrefixHash: "prefix-b",
        dynamicTailHash: "tail-b",
        stablePrefix: false,
        stableTail: false,
      },
    });

    expect(firstRuntime.inspect.context.evidence.latest(sessionId, "prompt_stability")).toEqual({
      kind: "prompt_stability",
      turn: 2,
      timestamp: 20,
      payload: {
        scopeKey: "session-evidence::root",
        stablePrefixHash: "prefix-b",
        dynamicTailHash: "tail-b",
        stablePrefix: false,
        stableTail: false,
      },
    });

    const restartedRuntime = createBrewvaRuntime({
      cwd: workspace,
      config: DEFAULT_BREWVA_CONFIG,
    }).hosted;

    expect({
      latest: restartedRuntime.inspect.context.evidence.latest(sessionId, "prompt_stability"),
    }).toEqual({ latest: undefined });
  });
});
