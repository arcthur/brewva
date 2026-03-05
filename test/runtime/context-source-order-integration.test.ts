import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  config.memory.enabled = true;
  config.infrastructure.contextBudget.enabled = true;
  config.infrastructure.contextBudget.maxInjectionTokens = 4_000;
  config.infrastructure.toolFailureInjection.enabled = true;
  return config;
}

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-context-order-${name}-`));
  writeFileSync(
    join(workspace, "AGENTS.md"),
    [
      "## CRITICAL RULES",
      "- User-facing command name is `brewva`.",
      "- Use workspace package imports `@brewva/brewva-runtime`.",
      "- Use Bun `1.3.9`.",
      "- Run bun run test:dist.",
    ].join("\n"),
    "utf8",
  );
  return workspace;
}

function patchMemory(runtime: BrewvaRuntime): void {
  const runtimeWithInternals = runtime as unknown as RuntimeWithInternals;
  runtimeWithInternals.contextService.memory.refreshIfNeeded = () => undefined;
  runtimeWithInternals.contextService.memory.getWorkingMemory = () => ({
    content: "[WorkingMemory]\nsummary: deterministic working memory block",
  });
}

function blockIndex(text: string, block: string): number {
  return text.indexOf(`[${block}]`);
}

describe("context source order integration", () => {
  test("injects deterministic governance sources without recall branch", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("strict-order"),
      config: createConfig(),
      agentId: "default",
    });
    patchMemory(runtime);

    const sessionId = "context-source-order";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Validate semantic source ordering",
      constraints: ["Keep deterministic source order"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "tool failure blocks completion",
      source: "test",
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: deterministic source order failure block",
      success: false,
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:order",
      kind: "diagnostic",
      severity: "warn",
      summary: "deterministic truth fact",
    });

    const injected = await runtime.context.buildInjection(
      sessionId,
      "verify context source ordering",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      "leaf-order",
    );
    expect(injected.accepted).toBe(true);
    expect(injected.text.length).toBeGreaterThan(0);
    const workingMemoryPosition = blockIndex(injected.text, "WorkingMemory");
    const truthLedgerPosition = blockIndex(injected.text, "TruthLedger");
    const truthFactsPosition = blockIndex(injected.text, "TruthFacts");
    const toolFailuresPosition = blockIndex(injected.text, "RecentToolFailures");
    const taskLedgerPosition = blockIndex(injected.text, "TaskLedger");
    expect(workingMemoryPosition).toBeGreaterThanOrEqual(0);
    expect(truthLedgerPosition).toBeGreaterThan(workingMemoryPosition);
    expect(truthFactsPosition).toBeGreaterThan(truthLedgerPosition);
    expect(toolFailuresPosition).toBeGreaterThan(truthFactsPosition);
    expect(taskLedgerPosition).toBeGreaterThan(toolFailuresPosition);
    expect(injected.text.includes("[MemoryRecall]")).toBe(false);
  });
});
