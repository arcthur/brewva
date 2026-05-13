import { describe, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { ContextBudgetManager } from "../../../packages/brewva-runtime/src/domain/context/budget.js";
import {
  evaluateContextCompactionGate,
  requestContextCompaction,
} from "../../../packages/brewva-runtime/src/domain/context/context-compaction-gate.js";
import {
  estimatePredictiveTurnGrowthTokens,
  getContextCompactionGateStatus,
  getContextUsageRatio,
} from "../../../packages/brewva-runtime/src/domain/context/context-pressure.js";
import type { ContextBudgetUsage } from "../../../packages/brewva-runtime/src/domain/context/types.js";
import type { BrewvaEventRecord } from "../../../packages/brewva-runtime/src/events/types.js";
import { setStaticContextStatusThresholds } from "../../fixtures/config.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createUsage(percent: number): ContextBudgetUsage {
  return {
    tokens: Math.round(percent * 1_000),
    contextWindow: 1_000,
    percent,
  };
}

function createWorkspaceWithSkills(name: string): string {
  const workspace = createTestWorkspace(name);
  const repoRoot = resolve(import.meta.dirname, "../../..");
  cpSync(resolve(repoRoot, "skills"), resolve(workspace, "skills"), { recursive: true });
  return workspace;
}

function createPressureHarness(input: {
  config: typeof DEFAULT_BREWVA_CONFIG;
  contextBudget: ContextBudgetManager;
  getCurrentTurn: (sessionId: string) => number;
  recordEvent: (eventInput: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
  }) => BrewvaEventRecord | undefined;
}) {
  return {
    observeContextUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void {
      input.contextBudget.observeUsage(sessionId, usage);
      if (!usage) return;
      input.recordEvent({
        sessionId,
        type: "context_usage",
        payload: {
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: getContextUsageRatio(usage),
        },
      });
    },
    getContextCompactionGateStatus(sessionId: string, usage?: ContextBudgetUsage) {
      return getContextCompactionGateStatus({
        config: input.config,
        contextBudget: input.contextBudget,
        sessionId,
        usage,
        getCurrentTurn: input.getCurrentTurn,
      });
    },
    checkContextCompactionGate(sessionId: string, toolName: string, usage?: ContextBudgetUsage) {
      return evaluateContextCompactionGate({
        config: input.config,
        contextBudget: input.contextBudget,
        sessionId,
        toolName,
        usage,
        getCurrentTurn: input.getCurrentTurn,
        recordEvent: input.recordEvent,
      });
    },
    explainContextCompactionGate(sessionId: string, toolName: string, usage?: ContextBudgetUsage) {
      return evaluateContextCompactionGate({
        config: input.config,
        contextBudget: input.contextBudget,
        sessionId,
        toolName,
        usage,
        getCurrentTurn: input.getCurrentTurn,
      });
    },
    requestCompaction(
      sessionId: string,
      reason: "usage_threshold" | "hard_limit" | "predicted_overflow",
      usage?: ContextBudgetUsage,
    ) {
      requestContextCompaction({
        contextBudget: input.contextBudget,
        sessionId,
        reason,
        usage,
        recordEvent: input.recordEvent,
      });
    },
  };
}

describe("context status derivation", () => {
  test("uses predictive turn-growth scaling between floor and large context windows", () => {
    const policy = {
      floorContextWindow: 1_000,
      largeContextWindow: 10_000,
      standardTokens: 200,
      largeTokens: 400,
      scalingFactor: 0.05,
    };

    expect(estimatePredictiveTurnGrowthTokens(999, policy)).toBe(0);
    expect(estimatePredictiveTurnGrowthTokens(1_000, policy)).toBe(200);
    expect(estimatePredictiveTurnGrowthTokens(6_000, policy)).toBe(300);
    expect(estimatePredictiveTurnGrowthTokens(9_000, policy)).toBe(400);
    expect(estimatePredictiveTurnGrowthTokens(10_000, policy)).toBe(400);
  });

  test("derives predictive overflow headroom from the hard compaction boundary", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    setStaticContextStatusThresholds(config, {
      hardLimitPercent: 0.9,
      compactionThresholdPercent: 0.8,
    });

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 1,
      recordEvent: () => undefined as BrewvaEventRecord | undefined,
    });

    const gate = service.getContextCompactionGateStatus("predictive-session", {
      tokens: 70_000,
      contextWindow: 100_000,
      percent: 0.7,
    });

    expect(gate.status).toEqual(
      expect.objectContaining({
        tokensUntilForcedCompact: 20_000,
        predictedTurnGrowthTokens: 35_000,
        tokensUntilPredictedOverflow: 0,
        predictedOverflow: true,
        compactionAdvised: false,
        forcedCompaction: false,
      }),
    );
  });

  test("derives predictive overflow from context-budget tuning", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    setStaticContextStatusThresholds(config, {
      hardLimitPercent: 0.9,
      compactionThresholdPercent: 0.8,
    });
    config.infrastructure.contextBudget.predictiveTurnGrowth = {
      floorContextWindow: 1_000,
      largeContextWindow: 10_000,
      standardTokens: 200,
      largeTokens: 400,
      scalingFactor: 0.1,
    };

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 1,
      recordEvent: () => undefined as BrewvaEventRecord | undefined,
    });

    const status = service.getContextCompactionGateStatus("predictive-tuned", {
      tokens: 8_650,
      contextWindow: 10_000,
      percent: 0.865,
    }).status;

    expect(status).toEqual(
      expect.objectContaining({
        predictedTurnGrowthTokens: 400,
        tokensUntilPredictedOverflow: 0,
        predictedOverflow: true,
        forcedCompaction: false,
      }),
    );
  });

  test("exposes effective and controllable context headroom from model physics", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.modelPhysics = {
      effectiveContextWindowPercent: 0.95,
      autoCompactLimitRatio: 0.9,
      controllableBaselineTokens: 12_000,
    };

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 1,
      recordEvent: () => undefined as BrewvaEventRecord | undefined,
    });

    const status = service.getContextCompactionGateStatus("physics-session", {
      tokens: 20_000,
      contextWindow: 100_000,
      percent: 0.2,
    }).status;

    expect(status).toEqual(
      expect.objectContaining({
        effectiveTokensTotal: 95_000,
        autoCompactLimitTokens: 90_000,
        controllableBaselineTokens: 12_000,
        controllableTokensUsed: 8_000,
        controllableTokensTotal: 83_000,
        controllableTokensRemaining: 75_000,
        controllableContextRemainingRatio: 75_000 / 83_000,
      }),
    );
  });

  test("blocks tools on forced compaction and emits expected payload", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    setStaticContextStatusThresholds(config, {
      hardLimitPercent: 0.8,
      compactionThresholdPercent: 0.7,
    });

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 12);

    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 12,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const usage = createUsage(0.9);
    service.observeContextUsage("pressure-session", usage);

    const gate = service.getContextCompactionGateStatus("pressure-session", usage);
    expect(gate.required).toBe(true);
    expect(gate.reason).toBe("hard_limit");

    const gateDecision = service.checkContextCompactionGate("pressure-session", "exec", usage);
    expect(gateDecision.allowed).toBe(false);

    const blocked = events.find((event) => event.type === "context_compaction_gate_blocked_tool");
    expect(blocked).toBeDefined();
    expect(blocked?.payload).toEqual(
      expect.objectContaining({
        blockedTool: "exec",
        reason: "critical_context_pressure_without_compaction",
        usagePercent: 0.9,
        hardLimitPercent: 0.8,
      }),
    );
  });

  test("deduplicates repeated hard_limit compaction request events", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 7);

    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 7,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const highUsage = createUsage(0.95);
    service.requestCompaction("pressure-session", "hard_limit", highUsage);
    service.requestCompaction("pressure-session", "hard_limit", highUsage);

    const requestedEvents = events.filter((event) => event.type === "context_compaction_requested");
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0]?.payload).toEqual(
      expect.objectContaining({
        reason: "hard_limit",
        usagePercent: 0.95,
        tokens: 950,
      }),
    );

    const gate = service.getContextCompactionGateStatus("pressure-session", highUsage);
    expect(gate.required).toBe(true);
    expect(gate.reason).toBe("hard_limit");
  });

  test("normalizes usagePercent in compaction request telemetry", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 8);

    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 8,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    service.requestCompaction("pressure-session", "hard_limit", {
      tokens: 950,
      contextWindow: 1_000,
      percent: 95,
    });

    const requestedEvent = events.find((event) => event.type === "context_compaction_requested");
    expect(requestedEvent?.payload).toEqual(
      expect.objectContaining({
        reason: "hard_limit",
        usagePercent: 0.95,
        tokens: 950,
      }),
    );
  });

  test("normalizes observed context usage telemetry into ratio form", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 1,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    service.observeContextUsage("pressure-session", {
      tokens: 950,
      contextWindow: 1_000,
      percent: 95,
    });

    const observedEvent = events.find((event) => event.type === "context_usage");
    expect(observedEvent?.payload).toEqual(
      expect.objectContaining({
        tokens: 950,
        contextWindow: 1_000,
        percent: 0.95,
      }),
    );
  });

  test("does not arm compaction gate from pending reason alone when pressure is below critical", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    setStaticContextStatusThresholds(config, {
      hardLimitPercent: 0.8,
      compactionThresholdPercent: 0.7,
    });

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 9);

    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 9,
      recordEvent: () => undefined as BrewvaEventRecord | undefined,
    });

    service.requestCompaction("pressure-session", "hard_limit", createUsage(0.5));

    const mediumUsage = createUsage(0.75);
    const gate = service.getContextCompactionGateStatus("pressure-session", mediumUsage);
    expect(gate.status.compactionAdvised).toBe(true);
    expect(gate.status.forcedCompaction).toBe(false);
    expect(gate.required).toBe(false);
    expect(gate.reason).toBeNull();

    const decision = service.checkContextCompactionGate("pressure-session", "exec", mediumUsage);
    expect(decision.allowed).toBe(true);
  });

  test("explaining the compaction gate does not emit blocked-tool telemetry", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    setStaticContextStatusThresholds(config, { hardLimitPercent: 0.8 });

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 12);

    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 12,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const usage = createUsage(0.9);
    service.observeContextUsage("pressure-session", usage);

    const explanation = service.explainContextCompactionGate("pressure-session", "exec", usage);
    expect(explanation.allowed).toBe(false);
    expect(events.some((event) => event.type === "context_compaction_gate_blocked_tool")).toBe(
      false,
    );
  });

  test("allows only workbench_compact during critical pressure", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    setStaticContextStatusThresholds(config, { hardLimitPercent: 0.8 });

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 12);

    const service = createPressureHarness({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 12,
      recordEvent: () => undefined as BrewvaEventRecord | undefined,
    });

    const usage = createUsage(0.9);
    const controlDecision = service.checkContextCompactionGate(
      "pressure-session",
      "workbench_compact",
      usage,
    );
    expect(controlDecision.allowed).toBe(true);

    const dataPlaneDecision = service.checkContextCompactionGate("pressure-session", "exec", usage);
    expect(dataPlaneDecision.allowed).toBe(false);
    expect(dataPlaneDecision.reason).toContain("Allowed during gate: workbench_compact.");
  });

  test("runtime wiring only allows compact during critical pressure", () => {
    const workspace = createWorkspaceWithSkills("pressure-runtime-wiring");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    setStaticContextStatusThresholds(config, {
      hardLimitPercent: 0.8,
      compactionThresholdPercent: 0.7,
    });
    config.infrastructure.events.enabled = true;
    config.infrastructure.events.dir = ".orchestrator/events";
    config.ledger.path = ".orchestrator/ledger/evidence.jsonl";
    const runtime = createBrewvaRuntime({ cwd: workspace, config }).hosted;

    const sessionId = "pressure-runtime-wiring-1";
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    const usage = createUsage(0.9);
    runtime.operator.context.usage.observe(sessionId, usage);

    for (const toolName of ["tape_info", "tape_search", "recall_search", "cost_view", "exec"]) {
      expect(runtime.inspect.context.compaction.checkGate(sessionId, toolName, usage).allowed).toBe(
        false,
      );
    }
    expect(
      runtime.inspect.context.compaction.checkGate(sessionId, "workbench_compact", usage).allowed,
    ).toBe(true);
  });
});
