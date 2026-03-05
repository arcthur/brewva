import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

type RuntimeWithInternals = {
  contextService: {
    memory: {
      refreshIfNeeded(input: { sessionId: string }): void;
      getWorkingMemory(sessionId: string): { content: string } | null;
    };
  };
};

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = true;
  return config;
}

function patchMemory(runtime: BrewvaRuntime): void {
  const runtimeWithInternals = runtime as unknown as RuntimeWithInternals;
  runtimeWithInternals.contextService.memory.refreshIfNeeded = () => undefined;
  runtimeWithInternals.contextService.memory.getWorkingMemory = () => ({
    content: "[WorkingMemory]\nsummary: deterministic working memory",
  });
}

describe("context memory split", () => {
  test("injects working-memory source only", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-split-"));
    const sessionId = "memory-split";

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig(),
    });
    patchMemory(runtime);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "baseline task state",
    });

    const injection = await runtime.context.buildInjection(sessionId, "deterministic memory split");
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[WorkingMemory]")).toBe(true);
    expect(injection.text.includes("[MemoryRecall]")).toBe(false);
  });
});
