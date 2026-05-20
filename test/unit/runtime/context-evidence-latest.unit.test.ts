import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("context evidence latest inspect surface", () => {
  test("keeps only lossy in-memory latest evidence per kind", () => {
    const workspace = createTestWorkspace("context-evidence-latest");
    const sessionId = "session-evidence";
    const firstRuntime = createRuntimeInstanceFixture({
      cwd: workspace,
      config: DEFAULT_BREWVA_CONFIG,
    });

    firstRuntime.ops.context.evidence.append(sessionId, {
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
    firstRuntime.ops.context.evidence.append(sessionId, {
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

    expect(firstRuntime.ops.context.evidence.latest(sessionId, "prompt_stability")).toEqual({
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

    const restartedRuntime = createRuntimeInstanceFixture({
      cwd: workspace,
      config: DEFAULT_BREWVA_CONFIG,
    });

    expect({
      latest: restartedRuntime.ops.context.evidence.latest(sessionId, "prompt_stability"),
    }).toEqual({ latest: undefined });
  });
});
