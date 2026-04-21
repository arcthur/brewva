import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDeliberationMemoryContextProvider,
  createNarrativeMemoryContextProvider,
  createOptimizationContinuityContextProvider,
} from "@brewva/brewva-deliberation";
import { createRecallContextProvider } from "@brewva/brewva-recall";
import {
  BrewvaRuntime,
  CONTEXT_SOURCES,
  DEFAULT_BREWVA_CONFIG,
  defineContextSourceProvider,
  type BrewvaConfig,
  type ContextSourceProvider,
  type ContextSourceProviderDescriptor,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { createSkillPromotionContextProvider } from "@brewva/brewva-skill-broker";
import { setStaticContextInjectionBudget } from "../../fixtures/config.js";
import { buildCanonicalReviewReport } from "../../helpers/semantic-artifacts.js";
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
      "- Use Bun `1.3.12`.",
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

function summarizeProviders(runtime: BrewvaRuntime) {
  return runtime.inspect.context.listProviders();
}

function registerCustomContextProvider(runtime: BrewvaRuntime): void {
  const provider = defineContextSourceProvider({
    kind: "working_state",
    source: "brewva.custom-operator-note",
    category: "constraint",
    collectionOrder: 55,
    selectionPriority: 55,
    readsFrom: ["test.customOperatorNote"],
    collect: (input) => {
      input.register({
        id: `custom-operator-note:${input.sessionId}`,
        content: "[CustomOperatorNote]\nstatus: custom provider registered through runtime.context",
      });
    },
  });
  runtime.maintain.context.registerProvider(provider);
}

function getProviderBrandSymbol(): symbol {
  const provider = defineContextSourceProvider({
    kind: "working_state",
    source: "brewva.test-brand-source",
    category: "narrative",
    collectionOrder: 1,
    readsFrom: ["test.brand"],
    collect: () => undefined,
  });
  const brand = Object.getOwnPropertySymbols(provider).find(
    (symbol) => (provider as unknown as Record<symbol, unknown>)[symbol] === true,
  );
  if (!brand) {
    throw new Error("Context source provider brand symbol was not found.");
  }
  return brand;
}

function expectedBaseProviders() {
  return [
    {
      source: CONTEXT_SOURCES.identity,
      plane: "contract_core",
      authorityTier: "operator_profile",
      admissionLane: "primary_registry",
      category: "narrative",
      budgetClass: "core",
      collectionOrder: 10,
      selectionPriority: 10,
      readsFrom: ["workspace.identity"],
      continuityCritical: false,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    },
    {
      source: CONTEXT_SOURCES.agentConstitution,
      plane: "contract_core",
      authorityTier: "operator_profile",
      admissionLane: "primary_registry",
      category: "narrative",
      budgetClass: "core",
      collectionOrder: 12,
      selectionPriority: 12,
      readsFrom: ["workspace.agentConstitution"],
      continuityCritical: false,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    },
    {
      source: CONTEXT_SOURCES.agentMemory,
      plane: "contract_core",
      authorityTier: "operator_profile",
      admissionLane: "primary_registry",
      category: "narrative",
      budgetClass: "core",
      collectionOrder: 13,
      selectionPriority: 13,
      readsFrom: ["workspace.agentMemory"],
      continuityCritical: false,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    },
    {
      source: CONTEXT_SOURCES.historyViewBaseline,
      plane: "history_view",
      authorityTier: "runtime_contract",
      admissionLane: "primary_registry",
      category: "narrative",
      budgetClass: "core",
      collectionOrder: 14,
      selectionPriority: 14,
      readsFrom: ["readModel.historyViewBaseline"],
      continuityCritical: true,
      profileSelectable: true,
      preservationPolicy: "non_truncatable",
      reservedBudgetRatio: 0.3,
    },
    {
      source: CONTEXT_SOURCES.skillRouting,
      plane: "advisory_recall",
      authorityTier: "advisory_recall",
      admissionLane: "primary_registry",
      category: "narrative",
      budgetClass: "recall",
      collectionOrder: 15,
      selectionPriority: 15,
      readsFrom: ["session.skillOutputs", "skill.registry"],
      continuityCritical: false,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    },
    {
      source: CONTEXT_SOURCES.runtimeStatus,
      plane: "working_state",
      authorityTier: "runtime_read_model",
      admissionLane: "primary_registry",
      category: "narrative",
      budgetClass: "core",
      collectionOrder: 20,
      selectionPriority: 20,
      readsFrom: ["view.runtimeStatus"],
      continuityCritical: false,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    },
    {
      source: CONTEXT_SOURCES.taskState,
      plane: "working_state",
      authorityTier: "runtime_contract",
      admissionLane: "primary_registry",
      category: "narrative",
      budgetClass: "core",
      collectionOrder: 40,
      selectionPriority: 40,
      readsFrom: ["view.taskState"],
      continuityCritical: false,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    },
    {
      source: CONTEXT_SOURCES.recoveryWorkingSet,
      plane: "working_state",
      authorityTier: "working_state",
      admissionLane: "primary_registry",
      category: "constraint",
      budgetClass: "working",
      collectionOrder: 45,
      selectionPriority: 45,
      readsFrom: ["readModel.recoveryWorkingSet"],
      continuityCritical: true,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    },
    {
      source: CONTEXT_SOURCES.projectionWorking,
      plane: "working_state",
      authorityTier: "working_state",
      admissionLane: "primary_registry",
      category: "narrative",
      budgetClass: "working",
      collectionOrder: 50,
      selectionPriority: 50,
      readsFrom: ["view.projectionWorking"],
      continuityCritical: false,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    },
  ] satisfies ContextSourceProviderDescriptor[];
}

describe("context source order integration", () => {
  test("exposes the full provider contract from runtime inspect", () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("provider-contract"),
      config: createConfig(),
      agentId: "default",
    });

    expect(summarizeProviders(runtime)).toEqual(expectedBaseProviders());
  });

  test("injects governance blocks in selection-priority order", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("strict-order"),
      config: createConfig(),
      agentId: "default",
    });
    patchProjection(runtime);

    const sessionId = "context-source-order";
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Validate semantic source ordering",
      constraints: ["Keep deterministic source order"],
    });
    runtime.authority.task.recordBlocker(sessionId, {
      message: "tool failure blocks completion",
      source: "test",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "design",
        outputKeys: ["design_spec"],
        outputs: {
          design_spec: "Deterministic workflow advisory for the active task.",
        },
      } as Record<string, unknown>,
    });
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: deterministic source order failure block",
      channelSuccess: false,
    });

    const injected = await runtime.maintain.context.buildInjection(
      sessionId,
      "verify context source ordering",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      { injectionScopeId: "leaf-order" },
    );

    const runtimeStatusPosition = blockIndex(injected.text, "RuntimeStatus");
    const taskLedgerPosition = blockIndex(injected.text, "TaskLedger");
    const workingProjectionPosition = blockIndex(injected.text, "WorkingProjection");
    expect(injected.accepted).toBe(true);
    expect(runtimeStatusPosition).toBeGreaterThanOrEqual(0);
    expect(taskLedgerPosition).toBeGreaterThan(runtimeStatusPosition);
    expect(workingProjectionPosition).toBeGreaterThan(taskLedgerPosition);
    expect(injected.text.includes("[MemoryRecall]")).toBe(false);
  });

  test("allows runtime callers to register and unregister fully-declared providers", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("custom-provider"),
      config: createConfig(),
      agentId: "default",
    });
    patchProjection(runtime);
    registerCustomContextProvider(runtime);

    const sessionId = "context-source-custom-provider";
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Validate externally registered provider order",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: buildCanonicalReviewReport("Review is green."),
          review_findings: [],
          merge_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: runtime status block should be present",
      channelSuccess: false,
    });

    expect(
      runtime.inspect.context
        .listProviders()
        .find((provider) => provider.source === "brewva.custom-operator-note"),
    ).toEqual({
      source: "brewva.custom-operator-note",
      plane: "working_state",
      authorityTier: "working_state",
      admissionLane: "primary_registry",
      category: "constraint",
      budgetClass: "working",
      collectionOrder: 55,
      selectionPriority: 55,
      readsFrom: ["test.customOperatorNote"],
      continuityCritical: false,
      profileSelectable: true,
      preservationPolicy: "truncatable",
    });

    const injected = await runtime.maintain.context.buildInjection(
      sessionId,
      "verify externally registered provider order",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      { injectionScopeId: "leaf-custom-provider" },
    );

    const runtimeStatusPosition = blockIndex(injected.text, "RuntimeStatus");
    const customProviderPosition = blockIndex(injected.text, "CustomOperatorNote");
    const taskLedgerPosition = blockIndex(injected.text, "TaskLedger");
    const workingProjectionPosition = blockIndex(injected.text, "WorkingProjection");
    expect(runtimeStatusPosition).toBeGreaterThanOrEqual(0);
    expect(taskLedgerPosition).toBeGreaterThan(runtimeStatusPosition);
    expect(workingProjectionPosition).toBeGreaterThan(taskLedgerPosition);
    expect(customProviderPosition).toBeGreaterThan(workingProjectionPosition);

    expect(runtime.maintain.context.unregisterProvider("brewva.custom-operator-note")).toBe(true);
    expect(runtime.maintain.context.unregisterProvider("brewva.custom-operator-note")).toBe(false);
  });

  test("rejects unconstructed context providers before admission", () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("unconstructed-provider"),
      config: createConfig(),
      agentId: "default",
    });

    expect(() =>
      runtime.maintain.context.registerProvider({
        source: "brewva.unconstructed-provider",
        plane: "working_state",
        authorityTier: "working_state",
        admissionLane: "primary_registry",
        category: "narrative",
        budgetClass: "working",
        collectionOrder: 60,
        selectionPriority: 60,
        readsFrom: ["test.unconstructed"],
        continuityCritical: false,
        profileSelectable: true,
        preservationPolicy: "truncatable",
        collect: () => undefined,
      } as unknown as ContextSourceProvider),
    ).toThrow("defineContextSourceProvider");
  });

  test("rejects malformed provider definitions at construction", () => {
    expect(() =>
      defineContextSourceProvider({
        kind: "working_state",
        source: "brewva.invalid-fractional-order",
        category: "narrative",
        collectionOrder: 1.5,
        readsFrom: ["test.invalidFractionalOrder"],
        collect: () => undefined,
      }),
    ).toThrow("collectionOrder must be an integer");

    expect(() =>
      defineContextSourceProvider({
        kind: "working_state",
        source: "brewva.invalid-read-dependency",
        category: "narrative",
        collectionOrder: 63,
        readsFrom: [" test.invalidReadDependency"],
        collect: () => undefined,
      }),
    ).toThrow("readsFrom entries must be trimmed");

    expect(() =>
      defineContextSourceProvider({
        kind: "working_state",
        source: "brewva.invalid-collect",
        category: "narrative",
        collectionOrder: 64,
        readsFrom: ["test.invalidCollect"],
        collect: undefined,
      } as unknown as Parameters<typeof defineContextSourceProvider>[0]),
    ).toThrow("collect must be a function");
  });

  test("rejects illegal descriptor combinations even when callers spoof construction", () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("provider-invariant-matrix"),
      config: createConfig(),
      agentId: "default",
    });
    const brand = getProviderBrandSymbol();

    expect(() =>
      runtime.maintain.context.registerProvider({
        [brand]: true,
        source: "brewva.invalid-working-core-budget",
        plane: "working_state",
        authorityTier: "working_state",
        admissionLane: "primary_registry",
        category: "narrative",
        budgetClass: "core",
        collectionOrder: 60,
        selectionPriority: 60,
        readsFrom: ["test.invalidWorking"],
        continuityCritical: false,
        profileSelectable: true,
        preservationPolicy: "truncatable",
        collect: () => undefined,
      } as unknown as ContextSourceProvider),
    ).toThrow("must use working budget");

    expect(() =>
      runtime.maintain.context.registerProvider({
        [brand]: true,
        source: "brewva.invalid-history-view",
        plane: "history_view",
        authorityTier: "runtime_contract",
        admissionLane: "primary_registry",
        category: "narrative",
        budgetClass: "core",
        collectionOrder: 61,
        selectionPriority: 61,
        readsFrom: ["test.invalidHistory"],
        continuityCritical: true,
        profileSelectable: true,
        preservationPolicy: "truncatable",
        reservedBudgetRatio: 1,
        collect: () => undefined,
      } as unknown as ContextSourceProvider),
    ).toThrow("History-view context source provider has an invalid descriptor combination");

    expect(() =>
      runtime.maintain.context.registerProvider({
        [brand]: true,
        source: "brewva.invalid-advisory-budget",
        plane: "advisory_recall",
        authorityTier: "advisory_recall",
        admissionLane: "primary_registry",
        category: "narrative",
        budgetClass: "core",
        collectionOrder: 62,
        selectionPriority: 62,
        readsFrom: ["test.invalidAdvisory"],
        continuityCritical: false,
        profileSelectable: true,
        preservationPolicy: "truncatable",
        collect: () => undefined,
      } as unknown as ContextSourceProvider),
    ).toThrow("Advisory context source provider has an invalid descriptor combination");
  });

  test("registers optional built-in providers only when config enables them", () => {
    const config = createConfig();
    config.skills.routing.enabled = true;
    config.infrastructure.toolOutputDistillationInjection.enabled = true;

    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("optional-builtins"),
      config,
      agentId: "default",
    });

    const expectedProviders = [
      ...expectedBaseProviders().slice(0, 6),
      {
        source: CONTEXT_SOURCES.toolOutputsDistilled,
        plane: "working_state",
        authorityTier: "runtime_read_model",
        admissionLane: "primary_registry",
        category: "narrative",
        budgetClass: "working",
        collectionOrder: 30,
        selectionPriority: 30,
        readsFrom: ["view.toolOutputDistillations"],
        continuityCritical: false,
        profileSelectable: true,
        preservationPolicy: "truncatable",
      },
      ...expectedBaseProviders().slice(6),
    ] satisfies ContextSourceProviderDescriptor[];

    expect(summarizeProviders(runtime)).toEqual(expectedProviders);
  });

  test("keeps advisory recall providers on recall budget and truncatable preservation", () => {
    const runtime = new BrewvaRuntime({
      cwd: createContextOrderWorkspace("advisory-provider-contract"),
      config: createConfig(),
      agentId: "default",
    });
    const advisoryProviders = [
      createRecallContextProvider({ runtime }),
      createNarrativeMemoryContextProvider({ runtime }),
      createDeliberationMemoryContextProvider({ runtime }),
      createOptimizationContinuityContextProvider({ runtime }),
      createSkillPromotionContextProvider({ runtime }),
    ];

    expect(
      advisoryProviders.map((provider) => ({
        source: provider.source,
        authorityTier: provider.authorityTier,
        plane: provider.plane,
        budgetClass: provider.budgetClass,
        preservationPolicy: provider.preservationPolicy,
        continuityCritical: provider.continuityCritical,
        collectionOrder: provider.collectionOrder,
        selectionPriority: provider.selectionPriority,
      })),
    ).toEqual([
      {
        source: CONTEXT_SOURCES.recallBroker,
        authorityTier: "advisory_recall",
        plane: "advisory_recall",
        budgetClass: "recall",
        preservationPolicy: "truncatable",
        continuityCritical: false,
        collectionOrder: 14,
        selectionPriority: 14,
      },
      {
        source: CONTEXT_SOURCES.narrativeMemory,
        authorityTier: "advisory_recall",
        plane: "advisory_recall",
        budgetClass: "recall",
        preservationPolicy: "truncatable",
        continuityCritical: false,
        collectionOrder: 42,
        selectionPriority: 42,
      },
      {
        source: CONTEXT_SOURCES.deliberationMemory,
        authorityTier: "advisory_recall",
        plane: "advisory_recall",
        budgetClass: "recall",
        preservationPolicy: "truncatable",
        continuityCritical: false,
        collectionOrder: 44,
        selectionPriority: 44,
      },
      {
        source: CONTEXT_SOURCES.optimizationContinuity,
        authorityTier: "advisory_recall",
        plane: "advisory_recall",
        budgetClass: "recall",
        preservationPolicy: "truncatable",
        continuityCritical: false,
        collectionOrder: 46,
        selectionPriority: 46,
      },
      {
        source: CONTEXT_SOURCES.skillPromotionDrafts,
        authorityTier: "advisory_recall",
        plane: "advisory_recall",
        budgetClass: "recall",
        preservationPolicy: "truncatable",
        continuityCritical: false,
        collectionOrder: 48,
        selectionPriority: 48,
      },
    ]);
  });
});
