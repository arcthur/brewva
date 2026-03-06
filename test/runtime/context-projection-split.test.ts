import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

type RuntimeWithInternals = {
  contextService: {
    projectionEngine: {
      refreshIfNeeded(input: { sessionId: string }): void;
      getWorkingProjection(sessionId: string): { content: string } | null;
    };
  };
};

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.toolFailureInjection.enabled = false;
  config.projection.enabled = true;
  return config;
}

function patchProjection(runtime: BrewvaRuntime): void {
  const runtimeWithInternals = runtime as unknown as RuntimeWithInternals;
  runtimeWithInternals.contextService.projectionEngine.refreshIfNeeded = () => undefined;
  runtimeWithInternals.contextService.projectionEngine.getWorkingProjection = () => ({
    content: "[WorkingProjection]\nsummary: deterministic working projection",
  });
}

describe("context projection split", () => {
  test("injects working-projection source only", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-split-"));
    const sessionId = "projection-split";

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig(),
    });
    patchProjection(runtime);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "baseline task state",
    });

    const injection = await runtime.context.buildInjection(
      sessionId,
      "deterministic projection split",
    );
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[WorkingProjection]")).toBe(true);
    expect(injection.text.includes("[MemoryRecall]")).toBe(false);
  });
});
