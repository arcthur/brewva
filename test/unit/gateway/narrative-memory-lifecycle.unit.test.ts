import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getOrCreateNarrativeMemoryPlane } from "@brewva/brewva-deliberation";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createNarrativeMemoryLifecycle } from "../../../packages/brewva-gateway/src/runtime-plugins/narrative-memory-lifecycle.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createLifecycleContext(sessionId: string) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as never;
}

describe("narrative memory lifecycle", () => {
  test("rejects passive candidates that contradict operator-authored agent memory", async () => {
    const workspace = createTestWorkspace("narrative-memory-lifecycle");
    const memoryPath = resolve(workspace, ".brewva", "agents", "default", "memory.md");
    mkdirSync(dirname(memoryPath), { recursive: true });
    writeFileSync(
      memoryPath,
      [
        "# Memory",
        "",
        "## Operator Preferences",
        "- Do not use npm commands in this repository.",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "narrative-memory-lifecycle-session";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Reject contradictory passive narrative memory.",
      targets: {
        files: ["packages/brewva-gateway/src/runtime-plugins/narrative-memory-lifecycle.ts"],
      },
    });

    const lifecycle = createNarrativeMemoryLifecycle(runtime);
    const ctx = createLifecycleContext(sessionId);
    if (!lifecycle.input || !lifecycle.agentEnd) {
      throw new Error("Expected narrative lifecycle port handlers.");
    }
    await lifecycle.input(
      {
        type: "input",
        source: "user",
        text: "Please use npm commands in this repository.",
      } as never,
      ctx,
    );
    await lifecycle.agentEnd(
      {
        type: "agent_end",
        messages: [],
      } as never,
      ctx,
    );

    const plane = getOrCreateNarrativeMemoryPlane(runtime);
    expect(plane.list()).toHaveLength(0);
  });

  test("uses semantic extraction for validated positive feedback and preserves structured content", async () => {
    const workspace = createTestWorkspace("narrative-memory-lifecycle-positive-feedback");
    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "narrative-memory-positive-feedback-session";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Capture durable positive collaboration feedback.",
      targets: {
        files: ["packages/brewva-gateway/src/runtime-plugins/narrative-memory-lifecycle.ts"],
      },
    });

    let extractionCalls = 0;
    const lifecycle = createNarrativeMemoryLifecycle(runtime, {
      extractNarrativeMemoryCandidate: async () => {
        extractionCalls += 1;
        return {
          class: "operator_preference",
          title: "Bundle Refactors When They Reduce Churn",
          summary: "Validated preference for a bundled PR in this area.",
          content: [
            "Prefer one bundled PR over many small ones for refactors in this area.",
            "Why: splitting this work would create churn without improving review quality.",
            "How to apply: favor a single reviewable change when the refactor touches one coherent boundary.",
          ].join("\n"),
          applicabilityScope: "operator",
          confidenceScore: 0.82,
        };
      },
    });
    const ctx = createLifecycleContext(sessionId);
    if (!lifecycle.input || !lifecycle.agentEnd) {
      throw new Error("Expected narrative lifecycle port handlers.");
    }

    await lifecycle.input(
      {
        type: "input",
        source: "user",
        text: "Yeah, the single bundled PR was the right call here. Keep doing that for refactors in this area.",
      } as never,
      ctx,
    );
    await lifecycle.agentEnd(
      {
        type: "agent_end",
        messages: [],
      } as never,
      ctx,
    );

    const plane = getOrCreateNarrativeMemoryPlane(runtime);
    const records = plane.list();
    expect(extractionCalls).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.content).toContain("Why:");
    expect(records[0]?.content).toContain("How to apply:");
  });
});
