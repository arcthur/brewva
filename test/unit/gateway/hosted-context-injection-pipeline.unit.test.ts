import { describe, expect, test } from "bun:test";
import {
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
  type ContextBudgetUsage,
  type ContextCompactionGateStatus,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { createHostedContextInjectionPipeline } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.js";
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
      sharedContextFiles: [],
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
        status: "completed",
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

    expect(result.message.content).toContain("[Brewva Skill-First Policy]");
    expect(result.message.content).toContain("No TaskSpec is currently recorded for this session.");
    expect(result.message.content).toContain("call `task_set_spec`");
    expect(result.message.details.skillRecommendation).toEqual({
      gateMode: "task_spec_required",
      taskSpecReady: false,
      names: [],
    });
    expect(recordedTypes).toContain("skill_recommendation_derived");
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

    expect(result.message.content).toContain("[Brewva Skill-First Policy]");
    expect(result.message.content).toContain("primary_skill: runtime-forensics");
    expect(result.message.details.skillRecommendation).toEqual({
      gateMode: "skill_load_required",
      taskSpecReady: true,
      names: ["runtime-forensics"],
    });
    expect(recordedTypes).toContain("skill_recommendation_derived");
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

    expect(result.message.content).toContain("[Brewva Skill-First Policy]");
    expect(result.message.content).toContain("No TaskSpec is currently recorded for this session.");
    expect(result.message.content).toContain("call `task_set_spec`");
  });

  test("emits skill recommendation telemetry once when the hard gate path returns early", async () => {
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
    expect(recordedTypes.filter((type) => type === "skill_recommendation_derived")).toHaveLength(1);
  });
});
