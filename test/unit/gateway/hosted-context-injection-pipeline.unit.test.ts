import { describe, expect, test } from "bun:test";
import {
  createHostedContextInjectionPipeline,
  createHostedContextTelemetry,
  readContextEvidenceRecords,
} from "@brewva/brewva-gateway/runtime-plugins";
import {
  CONTEXT_SOURCES,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
  type ContextSourceProviderDescriptor,
  type ContextBudgetUsage,
  type ContextCompactionGateStatus,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { createMockRuntimePluginApi } from "../../helpers/runtime-plugin.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

const HIGH_USAGE: ContextBudgetUsage = {
  tokens: 995,
  contextWindow: 1000,
  percent: 0.995,
};

const HARD_GATE_STATUS: ContextCompactionGateStatus = {
  required: true,
  reason: "hard_limit",
  pressure: {
    level: "critical",
    usageRatio: 0.995,
    hardLimitRatio: 0.95,
    compactionThresholdRatio: 0.8,
  },
  recentCompaction: false,
  windowTurns: 0,
  lastCompactionTurn: null,
  turnsSinceCompaction: null,
};

function installRuntimeForensicsSkill(runtime: ReturnType<typeof createRuntimeFixture>): void {
  const skill = {
    name: "runtime-forensics",
    description: "Investigate runtime traces, sessions, events, ledgers, and projections.",
    category: "domain" as const,
    markdown: "## Trigger\n\n- investigating runtime traces, sessions, or ledgers\n",
    contract: {
      name: "runtime-forensics",
      category: "domain" as const,
      routing: {
        scope: "domain" as const,
      },
      selection: {
        whenToUse:
          "Use when the task asks what happened at runtime and the answer must come from traces, ledgers, projections, or artifacts.",
        examples: [
          "Analyze this session trace.",
          "Explain the runtime events and ledger evidence.",
        ],
        paths: [".orchestrator", ".brewva"],
        phases: ["investigate", "verify"],
      },
      effects: {
        allowedEffects: ["workspace_read", "runtime_observe"],
        deniedEffects: [],
      },
      resources: {
        defaultLease: { maxToolCalls: 10, maxTokens: 10000 },
        hardCeiling: { maxToolCalls: 20, maxTokens: 20000 },
      },
      executionHints: {
        preferredTools: ["ledger_query"],
        fallbackTools: ["output_search"],
      },
    },
  };
  Object.assign(runtime.inspect.skills, {
    list: () => [skill],
    getActive: () => undefined,
    getLoadReport: () => ({
      roots: [],
      loadedSkills: [skill.name],
      routingEnabled: true,
      routingScopes: ["domain"],
      routableSkills: [skill.name],
      hiddenSkills: [],
      overlaySkills: [],
      projectGuidance: [],
      categories: {
        core: [],
        domain: [skill.name],
        operator: [],
        meta: [],
        internal: [],
      },
    }),
  });
}

describe("hosted context injection pipeline", () => {
  test("derives the minimal profile from current provider descriptors", async () => {
    let providers: ContextSourceProviderDescriptor[] = [
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
    ];
    const sourceSelections: string[][] = [];
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        listProviders: () => providers,
        buildInjection: async (
          _sessionId: string,
          _prompt: string,
          _usage: unknown,
          options?: {
            sourceSelection?: ReadonlySet<string>;
          },
        ) => {
          sourceSelections.push([...(options?.sourceSelection ?? new Set<string>())].toSorted());
          return {
            text: "",
            entries: [],
            accepted: false,
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
          };
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(
      api,
      runtime,
      telemetry,
      {
        getTurnIndex: () => 2,
        setLastRuntimeGateRequired: () => undefined,
      },
      { contextProfile: "minimal" },
    );

    await pipeline.beforeAgentStart({
      sessionId: "s-minimal-profile",
      sessionManager: {
        getLeafId: () => "leaf-minimal",
      },
      prompt: "continue",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4_000,
        percent: 0.025,
      },
    });

    expect(sourceSelections).toEqual([
      [CONTEXT_SOURCES.historyViewBaseline, CONTEXT_SOURCES.recoveryWorkingSet].toSorted(),
    ]);
  });

  test("recomputes the standard profile from provider descriptors on each turn", async () => {
    let providers: ContextSourceProviderDescriptor[] = [
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
        source: "custom.hidden-working",
        plane: "working_state",
        authorityTier: "working_state",
        admissionLane: "primary_registry",
        category: "diagnostic",
        budgetClass: "working",
        collectionOrder: 60,
        selectionPriority: 60,
        readsFrom: ["test.hidden"],
        continuityCritical: false,
        profileSelectable: false,
        preservationPolicy: "truncatable",
      },
    ];
    const sourceSelections: string[][] = [];
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        listProviders: () => providers,
        buildInjection: async (
          _sessionId: string,
          _prompt: string,
          _usage: unknown,
          options?: {
            sourceSelection?: ReadonlySet<string>;
          },
        ) => {
          sourceSelections.push([...(options?.sourceSelection ?? new Set<string>())].toSorted());
          return {
            text: "",
            entries: [],
            accepted: false,
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
          };
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(
      api,
      runtime,
      telemetry,
      {
        getTurnIndex: () => 4,
        setLastRuntimeGateRequired: () => undefined,
      },
      { contextProfile: "standard" },
    );

    await pipeline.beforeAgentStart({
      sessionId: "s-standard-profile",
      sessionManager: {
        getLeafId: () => "leaf-standard",
      },
      prompt: "continue",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4_000,
        percent: 0.025,
      },
    });

    providers = [
      ...providers,
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
    ];

    await pipeline.beforeAgentStart({
      sessionId: "s-standard-profile",
      sessionManager: {
        getLeafId: () => "leaf-standard-2",
      },
      prompt: "continue again",
      systemPrompt: "base prompt",
      usage: {
        tokens: 120,
        contextWindow: 4_000,
        percent: 0.03,
      },
    });

    expect(sourceSelections).toEqual([
      [CONTEXT_SOURCES.historyViewBaseline, CONTEXT_SOURCES.runtimeStatus].toSorted(),
      [
        CONTEXT_SOURCES.historyViewBaseline,
        CONTEXT_SOURCES.projectionWorking,
        CONTEXT_SOURCES.runtimeStatus,
      ].toSorted(),
    ]);
  });

  test("fails closed on a hard gate without calling buildInjection", async () => {
    const recordedTypes: string[] = [];
    let buildInjectionCalls = 0;
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => HARD_GATE_STATUS,
        getPendingCompactionReason: () => "hard_limit",
        buildInjection: async () => {
          buildInjectionCalls += 1;
          return {
            text: "unexpected",
            entries: [],
            accepted: false,
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
          };
        },
      },
      events: {
        record: (input: { type: string }) => {
          recordedTypes.push(input.type);
          return undefined;
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const gateWrites: Array<{ sessionId: string; required: boolean }> = [];
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 12,
      setLastRuntimeGateRequired: (sessionId, required) => {
        gateWrites.push({ sessionId, required });
      },
    });

    const result = await pipeline.beforeAgentStart({
      sessionId: "s-gated",
      sessionManager: {
        getLeafId: () => "leaf-gated",
      },
      prompt: "continue",
      systemPrompt: "base prompt",
      usage: HIGH_USAGE,
    });

    expect(buildInjectionCalls).toBe(0);
    expect(gateWrites).toEqual([{ sessionId: "s-gated", required: true }]);
    expect(result.message.customType).toBe("brewva-context-injection");
    expect(result.message.display).toBe(false);
    expect(result.message.details.gateRequired).toBe(true);
    expect(recordedTypes).toContain("context_compaction_gate_armed");
    expect(recordedTypes).toContain("critical_without_compact");
    expect(recordedTypes).toContain("context_composed");
    expect(recordedTypes.some((type) => type.startsWith("context_cache_"))).toBe(false);
    expect(runtime.inspect.context.getPromptStability("s-gated")).toMatchObject({
      turn: 12,
      scopeKey: "s-gated::leaf-gated",
      stablePrefix: true,
      stableTail: true,
    });
    expect(
      readContextEvidenceRecords({
        workspaceRoot: runtime.workspaceRoot,
        sessionIds: ["s-gated"],
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "prompt_stability",
        sessionId: "s-gated",
        turn: 12,
        scopeKey: "s-gated::leaf-gated",
        stablePrefix: true,
        stableTail: true,
        pressureLevel: "critical",
        pendingCompactionReason: "hard_limit",
        gateRequired: true,
      }),
    ]);
  });

  test("records prompt stability on the normal composition path and tracks scope changes", async () => {
    const recordedTypes: string[] = [];
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string }) => {
          recordedTypes.push(input.type);
          return undefined;
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 7,
      setLastRuntimeGateRequired: () => undefined,
    });

    const invoke = (leafId: string) =>
      pipeline.beforeAgentStart({
        sessionId: "s-stability",
        sessionManager: {
          getLeafId: () => leafId,
        },
        prompt: "continue",
        systemPrompt: "base prompt",
        usage: {
          tokens: 100,
          contextWindow: 4000,
          percent: 0.025,
        },
      });

    await invoke("leaf-a");
    expect(runtime.inspect.context.getPromptStability("s-stability")).toMatchObject({
      turn: 7,
      scopeKey: "s-stability::leaf-a",
      stablePrefix: true,
      stableTail: true,
    });

    await invoke("leaf-a");
    expect(runtime.inspect.context.getPromptStability("s-stability")).toMatchObject({
      scopeKey: "s-stability::leaf-a",
      stablePrefix: true,
      stableTail: true,
    });

    await invoke("leaf-b");
    expect(runtime.inspect.context.getPromptStability("s-stability")).toMatchObject({
      scopeKey: "s-stability::leaf-b",
      stablePrefix: true,
      stableTail: false,
    });
    const evidenceRecords = readContextEvidenceRecords({
      workspaceRoot: runtime.workspaceRoot,
      sessionIds: ["s-stability"],
    }).filter((record) => record.kind === "prompt_stability");
    expect(evidenceRecords).toHaveLength(3);
    expect(evidenceRecords.at(-1)).toEqual(
      expect.objectContaining({
        sessionId: "s-stability",
        turn: 7,
        scopeKey: "s-stability::leaf-b",
        stablePrefix: true,
        stableTail: false,
        gateRequired: false,
      }),
    );
    expect(recordedTypes.some((type) => type.startsWith("context_cache_"))).toBe(false);
  });

  test("keeps the system contract static while pressure guidance stays in the dynamic tail", async () => {
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: (_sessionId: string, usage?: ContextBudgetUsage) => ({
          required: false,
          reason: null,
          pressure: {
            level: "high",
            usageRatio: usage?.percent ?? 0,
            hardLimitRatio: usage?.contextWindow === 1000 ? 0.95 : 0.97,
            compactionThresholdRatio: usage?.contextWindow === 1000 ? 0.8 : 0.9,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => "usage_threshold",
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 8,
      setLastRuntimeGateRequired: () => undefined,
    });

    const invoke = (usage: ContextBudgetUsage) =>
      pipeline.beforeAgentStart({
        sessionId: "s-guidance",
        sessionManager: {
          getLeafId: () => "leaf-guidance",
        },
        prompt: "continue",
        systemPrompt: "base prompt",
        usage,
      });

    const first = await invoke({
      tokens: 820,
      contextWindow: 1000,
      percent: 0.82,
    });
    const second = await invoke({
      tokens: 1800,
      contextWindow: 2000,
      percent: 0.9,
    });

    expect(first.systemPrompt).toBe(second.systemPrompt);
    expect(first.systemPrompt).toContain("[Brewva Context Contract]");
    expect(first.systemPrompt).not.toContain("80%");
    expect(first.systemPrompt).not.toContain("90%");
    expect(first.message.content).toContain("Current usage: 82% (compact-soon threshold: 80%).");
    expect(second.message.content).toContain("Current usage: 90% (compact-soon threshold: 90%).");
    expect(runtime.inspect.context.getPromptStability("s-guidance")).toMatchObject({
      scopeKey: "s-guidance::leaf-guidance",
      stablePrefix: true,
      stableTail: false,
    });
  });

  test("adds a recovery working-set block after hosted recovery transitions", async () => {
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
      },
    });
    const sessionId = "s-recovery-working-set";
    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Continue the interrupted task",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "provider_fallback_retry",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: "provider/model-b",
      },
    });

    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 3,
      setLastRuntimeGateRequired: () => undefined,
    });

    const result = await pipeline.beforeAgentStart({
      sessionId,
      sessionManager: {
        getLeafId: () => "leaf-recovery",
      },
      prompt: "resume",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4000,
        percent: 0.025,
      },
    });

    expect(result.message.content).toContain("[RecoveryWorkingSet]");
    expect(result.message.content).toContain("latest_reason: provider_fallback_retry");
    expect(result.message.content).toContain("task_goal: Continue the interrupted task");
  });

  test("adds a read path recovery block after repeated missing-path read failures", async () => {
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
    });
    Object.assign(runtime.inspect.skills, {
      getLoadReport: () => ({
        loadedSkills: [],
        routingEnabled: true,
        routingScopes: ["core", "domain"],
        routableSkills: [],
        hiddenSkills: [],
        overlaySkills: [],
      }),
    });
    const sessionId = "s-read-path-recovery";
    for (const path of ["src/ghost-a.ts", "src/ghost-b.ts"]) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type: "tool_result_recorded",
        payload: {
          toolName: "read",
          verdict: "fail",
          failureContext: {
            args: { path },
            outputText: `ENOENT: no such file or directory, open '${path}'`,
            failureClass: "execution",
            turn: 1,
          },
        },
      });
    }
    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
      payload: {
        consecutiveMissingPathFailures: 2,
        failedPaths: ["src/ghost-b.ts", "src/ghost-a.ts"],
      },
    });

    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 4,
      setLastRuntimeGateRequired: () => undefined,
    });

    const result = await pipeline.beforeAgentStart({
      sessionId,
      sessionManager: {
        getLeafId: () => "leaf-read-path-recovery",
      },
      prompt: "继续排查为什么 read 一直失败。",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4000,
        percent: 0.025,
      },
    });

    expect(result.message.content).toContain("[Brewva Read Path Recovery]");
    expect(result.message.content).toContain("src/ghost-a.ts");
    expect(result.message.content).toContain("src/ghost-b.ts");
  });

  test("surfaces skill routing availability when skills are loaded but none are auto-routable", async () => {
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
    });
    Object.assign(runtime.inspect.skills, {
      getLoadReport: () => ({
        loadedSkills: ["repository-analysis", "debugging"],
        routingEnabled: false,
        routingScopes: ["core", "domain"],
        routableSkills: [],
        hiddenSkills: ["repository-analysis", "debugging"],
        overlaySkills: [],
      }),
      list: () => [],
      getActive: () => undefined,
    });

    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 5,
      setLastRuntimeGateRequired: () => undefined,
    });

    const result = await pipeline.beforeAgentStart({
      sessionId: "s-skill-routing-availability",
      sessionManager: {
        getLeafId: () => "leaf-skill-routing-availability",
      },
      prompt: "继续分析仓库。",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4000,
        percent: 0.025,
      },
    });

    expect(result.message.content).toContain("[Brewva Skill Routing Availability]");
    expect(result.message.content).toContain("automatic skill routing is disabled");
    expect(result.message.content).toContain("repository-analysis");
  });

  test("injects a bootstrap skill-first policy block when TaskSpec is missing", async () => {
    const recordedTypes: string[] = [];
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string }) => {
          recordedTypes.push(input.type);
          return undefined;
        },
      },
    });
    installRuntimeForensicsSkill(runtime);
    Object.assign(runtime.inspect.task, {
      getState: () => ({
        status: { phase: "investigate" },
      }),
    });

    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 4,
      setLastRuntimeGateRequired: () => undefined,
    });

    const result = await pipeline.beforeAgentStart({
      sessionId: "s-skill-first",
      sessionManager: {
        getLeafId: () => "leaf-skill-first",
      },
      prompt: "分析这个 session trace、runtime 事件和 ledger，判断 projection 是否合理。",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4000,
        percent: 0.025,
      },
    });

    expect(result.message.content).toContain("[Brewva Skill Diagnosis]");
    expect(result.message.content).toContain("posture: recommend_task_spec");
    expect(result.message.content).toContain("selected_skill: none");
    expect(result.message.content).toContain("readiness: task_spec_missing");
    expect(result.message.content).toContain("shortest_next_action: Call task_set_spec");
    expect(result.message.details.skillDiagnosis).toEqual({
      activationPosture: {
        kind: "recommend_task_spec",
        reason: "Prompt has enough task context to benefit from an explicit TaskSpec.",
      },
      toolAvailabilityPosture: "recommend",
      taskSpecReady: false,
      names: [],
      selected: null,
      shortestNextAction: "Call task_set_spec if the task needs deeper skill routing.",
    });
    expect(recordedTypes).toContain("skill_diagnosis_derived");
  });

  test("injects a skill-load requirement once TaskSpec is present", async () => {
    const recordedTypes: string[] = [];
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string }) => {
          recordedTypes.push(input.type);
          return undefined;
        },
      },
    });
    installRuntimeForensicsSkill(runtime);
    Object.assign(runtime.inspect.task, {
      getState: () => ({
        spec: {
          schema: "brewva.task.v1",
          goal: "Investigate what happened in this hosted runtime session by reading the trace, ledger, and projection artifacts.",
          expectedBehavior:
            "Explain the runtime events and identify whether the session behavior was valid.",
          constraints: ["Read-only investigation"],
          targets: {
            files: [".orchestrator/events", ".brewva/agent/sessions"],
          },
        },
        status: { phase: "investigate" },
        items: [],
        blockers: [],
        updatedAt: null,
      }),
    });

    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 5,
      setLastRuntimeGateRequired: () => undefined,
    });

    const result = await pipeline.beforeAgentStart({
      sessionId: "s-skill-first-with-spec",
      sessionManager: {
        getLeafId: () => "leaf-skill-first-with-spec",
      },
      prompt: "继续分析这次 session 的 trace 和 ledger。",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4000,
        percent: 0.025,
      },
    });

    expect(result.message.content).toContain("[Brewva Skill Diagnosis]");
    expect(result.message.content).toContain("posture: recommend_skill_load");
    expect(result.message.content).toContain("selected_skill: runtime-forensics");
    expect(result.message.content).toContain("readiness:");
    expect(result.message.content).toContain("missing_required_inputs:");
    expect(result.message.content).toContain(
      'shortest_next_action: Call skill_load with name "runtime-forensics".',
    );
    expect(result.message.content).not.toContain("selected_basis:");
    expect(result.message.content).not.toContain("shallow_output_risk:");
    expect(result.message.content).not.toContain("rejected_skills:");
    expect(result.message.details.skillDiagnosis).toEqual({
      activationPosture: {
        kind: "recommend_skill_load",
        skillNames: ["runtime-forensics"],
        reason: "TaskSpec strongly matches routable loaded skills.",
      },
      toolAvailabilityPosture: "recommend",
      taskSpecReady: true,
      names: ["runtime-forensics"],
      selected: "runtime-forensics",
      shortestNextAction: 'Call skill_load with name "runtime-forensics".',
    });
    expect(recordedTypes).toContain("skill_diagnosis_derived");
  });

  test("legacy blocker text does not bypass the TaskSpec-first bootstrap gate", async () => {
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
    });
    installRuntimeForensicsSkill(runtime);
    Object.assign(runtime.inspect.task, {
      getState: () => ({
        status: { phase: "investigate" },
        blockers: [
          {
            id: "legacy-blocker",
            text: "Investigate this runtime session trace and ledger drift in .brewva artifacts.",
          },
        ],
      }),
    });

    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 5,
      setLastRuntimeGateRequired: () => undefined,
    });

    const result = await pipeline.beforeAgentStart({
      sessionId: "s-skill-first-legacy-blocker",
      sessionManager: {
        getLeafId: () => "leaf-skill-first-legacy-blocker",
      },
      prompt: "continue",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4000,
        percent: 0.025,
      },
    });

    expect(result.message.content).toContain("[Brewva Skill Diagnosis]");
    expect(result.message.content).toContain("posture: recommend_task_spec");
    expect(result.message.content).toContain("selected_skill: none");
    expect(result.message.content).toContain("readiness: task_spec_missing");
    expect(result.message.content).toContain("shortest_next_action: Call task_set_spec");
  });

  test("emits skill diagnosis telemetry once when the hard gate path returns early", async () => {
    const recordedTypes: string[] = [];
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => HARD_GATE_STATUS,
        getPendingCompactionReason: () => "hard_limit",
        buildInjection: async () => ({
          text: "unexpected",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string }) => {
          recordedTypes.push(input.type);
          return undefined;
        },
      },
    });
    installRuntimeForensicsSkill(runtime);
    Object.assign(runtime.inspect.task, {
      getState: () => ({
        status: { phase: "investigate" },
      }),
    });

    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 6,
      setLastRuntimeGateRequired: () => undefined,
    });

    const result = await pipeline.beforeAgentStart({
      sessionId: "s-skill-first-gated",
      sessionManager: {
        getLeafId: () => "leaf-skill-first-gated",
      },
      prompt: "Analyze this session trace and runtime ledger before proceeding.",
      systemPrompt: "base prompt",
      usage: HIGH_USAGE,
    });

    expect(result.message.details.gateRequired).toBe(true);
    expect(recordedTypes.filter((type) => type === "skill_diagnosis_derived")).toHaveLength(1);
  });
});
