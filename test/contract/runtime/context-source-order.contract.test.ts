import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  CONTEXT_SOURCES,
  DEFAULT_BREWVA_CONFIG,
  type BrewvaConfig,
  type ContextSourceProvider,
} from "@brewva/brewva-runtime";
import { setStaticContextInjectionBudget } from "../../fixtures/config.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

type RuntimeWithInternals = {
  projectionEngine: {
    refreshIfNeeded(input: { sessionId: string }): void;
    getWorkingProjection(sessionId: string): { content: string } | null;
  };
};

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.projection.enabled = true;
  config.infrastructure.contextBudget.enabled = true;
  setStaticContextInjectionBudget(config, 4_000);
  config.infrastructure.toolFailureInjection.enabled = true;
  return config;
}

function createContextOrderWorkspace(name: string): string {
  const workspace = createTestWorkspace(`context-order-${name}`);
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

function patchProjection(runtime: BrewvaRuntime): void {
  const runtimeWithInternals = runtime as unknown as RuntimeWithInternals;
  runtimeWithInternals.projectionEngine.refreshIfNeeded = () => undefined;
  runtimeWithInternals.projectionEngine.getWorkingProjection = () => ({
    content: "[WorkingProjection]\nsummary: deterministic working projection block",
  });
}

function blockIndex(text: string, block: string): number {
  return text.indexOf(`[${block}]`);
}

function registerCustomContextProvider(runtime: BrewvaRuntime): void {
  const provider: ContextSourceProvider = {
    source: "brewva.custom-operator-note",
    category: "constraint",
    order: 55,
    collect: (input) => {
      input.register({
        id: `custom-operator-note:${input.sessionId}`,
        content: "[CustomOperatorNote]\nstatus: custom provider registered through runtime.context",
      });
    },
  };
  runtime.context.registerProvider(provider);
}

describe("context source order integration", () => {
  test("injects deterministic governance sources without recall branch", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("strict-order"),
      config: createConfig(),
      agentId: "default",
    });
    patchProjection(runtime);

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
      channelSuccess: false,
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:order",
      kind: "diagnostic",
      severity: "warn",
      summary: "deterministic truth fact",
    });
    expect(runtime.context.listProviders()).toEqual([
      { source: CONTEXT_SOURCES.identity, category: "narrative", order: 10 },
      { source: CONTEXT_SOURCES.contextPackets, category: "narrative", order: 30 },
      { source: CONTEXT_SOURCES.runtimeStatus, category: "narrative", order: 40 },
      { source: CONTEXT_SOURCES.taskState, category: "narrative", order: 60 },
      { source: CONTEXT_SOURCES.projectionWorking, category: "narrative", order: 70 },
    ]);

    const injected = await runtime.context.buildInjection(
      sessionId,
      "verify context source ordering",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      "leaf-order",
    );
    expect(injected.accepted).toBe(true);
    expect(injected.text.length).toBeGreaterThan(0);
    const runtimeStatusPosition = blockIndex(injected.text, "RuntimeStatus");
    const taskLedgerPosition = blockIndex(injected.text, "TaskLedger");
    const workingProjectionPosition = blockIndex(injected.text, "WorkingProjection");
    expect(injected.text.includes("[TruthLedger]")).toBe(false);
    expect(injected.text.includes("[TruthFacts]")).toBe(false);
    expect(runtimeStatusPosition).toBeGreaterThanOrEqual(0);
    expect(taskLedgerPosition).toBeGreaterThan(runtimeStatusPosition);
    expect(workingProjectionPosition).toBeGreaterThan(taskLedgerPosition);
    expect(injected.text.includes("[MemoryRecall]")).toBe(false);
  });

  test("allows runtime callers to register and unregister context providers", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("custom-provider"),
      config: createConfig(),
      agentId: "default",
    });
    patchProjection(runtime);
    registerCustomContextProvider(runtime);

    const sessionId = "context-source-custom-provider";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Validate externally registered provider order",
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: runtime status block should be present",
      channelSuccess: false,
    });

    const providers = runtime.context.listProviders();
    expect(providers.some((provider) => provider.source === "brewva.custom-operator-note")).toBe(
      true,
    );
    expect(providers.find((provider) => provider.source === "brewva.custom-operator-note")).toEqual(
      {
        source: "brewva.custom-operator-note",
        category: "constraint",
        order: 55,
      },
    );

    const injected = await runtime.context.buildInjection(
      sessionId,
      "verify externally registered provider order",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      "leaf-custom-provider",
    );

    const runtimeStatusPosition = blockIndex(injected.text, "RuntimeStatus");
    const customProviderPosition = blockIndex(injected.text, "CustomOperatorNote");
    const taskLedgerPosition = blockIndex(injected.text, "TaskLedger");
    expect(runtimeStatusPosition).toBeGreaterThanOrEqual(0);
    expect(customProviderPosition).toBeGreaterThan(runtimeStatusPosition);
    expect(taskLedgerPosition).toBeGreaterThan(customProviderPosition);

    expect(runtime.context.unregisterProvider("brewva.custom-operator-note")).toBe(true);
    expect(runtime.context.unregisterProvider("brewva.custom-operator-note")).toBe(false);
    expect(
      runtime.context
        .listProviders()
        .some((provider) => provider.source === "brewva.custom-operator-note"),
    ).toBe(false);

    const otherSessionId = "context-source-custom-provider-removed";
    runtime.context.onTurnStart(otherSessionId, 1);
    runtime.task.setSpec(otherSessionId, {
      schema: "brewva.task.v1",
      goal: "Validate provider removal",
    });
    runtime.tools.recordResult({
      sessionId: otherSessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: runtime status block should still be present",
      channelSuccess: false,
    });

    const afterRemoval = await runtime.context.buildInjection(
      otherSessionId,
      "verify provider removal",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      "leaf-custom-provider-removed",
    );
    expect(afterRemoval.text.includes("[CustomOperatorNote]")).toBe(false);
  });

  test("rejects duplicate context provider sources", () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("custom-provider-duplicate"),
      config: createConfig(),
      agentId: "default",
    });
    registerCustomContextProvider(runtime);

    expect(() => registerCustomContextProvider(runtime)).toThrow(
      "Context source provider already registered: brewva.custom-operator-note",
    );
  });

  test("registers optional built-in providers only when config enables them", () => {
    const config = createConfig();
    config.skills.routing.enabled = true;
    config.skills.cascade.mode = "assist";
    config.infrastructure.toolOutputDistillationInjection.enabled = true;

    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("optional-builtins"),
      config,
      agentId: "default",
    });

    expect(runtime.context.listProviders()).toEqual([
      { source: CONTEXT_SOURCES.identity, category: "narrative", order: 10 },
      { source: CONTEXT_SOURCES.skillCandidates, category: "narrative", order: 20 },
      { source: CONTEXT_SOURCES.skillCascadeGate, category: "constraint", order: 25 },
      { source: CONTEXT_SOURCES.contextPackets, category: "narrative", order: 30 },
      { source: CONTEXT_SOURCES.runtimeStatus, category: "narrative", order: 40 },
      { source: CONTEXT_SOURCES.toolOutputsDistilled, category: "narrative", order: 50 },
      { source: CONTEXT_SOURCES.taskState, category: "narrative", order: 60 },
      { source: CONTEXT_SOURCES.projectionWorking, category: "narrative", order: 70 },
    ]);
  });
});
