import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createDeliberationMemoryTool } from "@brewva/brewva-tools";
import { createTestWorkspace } from "../../helpers/workspace.js";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function createToolContext(sessionId: string) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as never;
}

describe("deliberation memory tool", () => {
  test("lists, retrieves, shows, and summarizes deliberation memory artifacts", async () => {
    const workspace = createTestWorkspace("deliberation-memory-tool");
    const runtime = new BrewvaRuntime({ cwd: workspace });

    runtime.task.setSpec("memory-session-1", {
      schema: "brewva.task.v1",
      goal: "Keep repository verification strict and evidence-backed.",
      verification: {
        commands: ["bun run check", "bun test"],
      },
      constraints: ["no backward compatibility"],
      targets: {
        files: ["packages/brewva-runtime/src/runtime.ts"],
      },
    });
    runtime.task.setSpec("memory-session-2", {
      schema: "brewva.task.v1",
      goal: "Preserve explicit constraints and narrow file scope.",
      verification: {
        commands: ["bun test"],
      },
      constraints: ["keep runtime authority narrow"],
      targets: {
        files: ["packages/brewva-deliberation/src/memory.ts"],
      },
    });
    runtime.events.recordMetricObservation("memory-session-1", {
      metricKey: "failed_checks",
      value: 3,
      source: "goal-loop:memory-loop",
      iterationKey: "memory-loop/run-1/iter-1",
      evidenceRefs: ["metric:memory-session-1"],
      summary: "Failed checks dropped to 3.",
    });

    const tool = createDeliberationMemoryTool({ runtime });
    const ctx = createToolContext("memory-session-1");

    const statsResult = await tool.execute(
      "tc-deliberation-memory-stats",
      { action: "stats" } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(statsResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("# Deliberation Memory Stats");

    const listResult = await tool.execute(
      "tc-deliberation-memory-list",
      { action: "list", kind: "repository_strategy_memory" } as never,
      undefined,
      undefined,
      ctx,
    );
    const listText = extractText(listResult as { content: Array<{ type: string; text?: string }> });
    const listDetails = listResult.details as
      | { artifacts?: Array<{ id: string; kind: string }> }
      | undefined;
    expect(listText).toContain("# Deliberation Memory Artifacts");
    expect(listText).toContain("repository-working-contract");
    expect(listDetails?.artifacts?.length).toBeGreaterThan(0);

    const retrieveResult = await tool.execute(
      "tc-deliberation-memory-retrieve",
      { action: "retrieve", query: "loop metric failed checks" } as never,
      undefined,
      undefined,
      ctx,
    );
    const retrieveText = extractText(
      retrieveResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(retrieveText).toContain("# Deliberation Memory Retrieval");
    expect(retrieveText).toContain("retrieval_score=");

    const artifactId = listDetails?.artifacts?.[0]?.id;
    expect(typeof artifactId).toBe("string");

    const showResult = await tool.execute(
      "tc-deliberation-memory-show",
      { action: "show", artifact_id: artifactId! } as never,
      undefined,
      undefined,
      ctx,
    );
    const showText = extractText(showResult as { content: Array<{ type: string; text?: string }> });
    expect(showText).toContain("# Deliberation Memory");
    expect(showText).toContain("retention_score:");
  });
});
