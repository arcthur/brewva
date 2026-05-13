import { describe, expect, test } from "bun:test";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-runtime/context";
import {
  commitHostedContextMaterialization,
  HOSTED_CONTEXT_MATERIALIZATION_EFFECT_ORDER,
  planHostedContextMaterialization,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/materialization.js";

type MaterializationInput = Parameters<typeof planHostedContextMaterialization>[0];

const baseContextStatus: ContextStatus = {
  tokensUsed: null,
  tokensTotal: 200_000,
  effectiveTokensTotal: 200_000,
  tokensRemaining: null,
  autoCompactLimitTokens: 170_000,
  controllableBaselineTokens: 0,
  controllableTokensUsed: null,
  controllableTokensTotal: 200_000,
  controllableTokensRemaining: null,
  controllableContextRemainingRatio: null,
  tokensUntilForcedCompact: null,
  predictedTurnGrowthTokens: 0,
  tokensUntilPredictedOverflow: null,
  predictedOverflow: false,
  usageRatio: null,
  hardLimitRatio: 0.92,
  compactionThresholdRatio: 0.85,
  compactionAdvised: false,
  forcedCompaction: false,
};

function gateStatus(input: Partial<ContextCompactionGateStatus>): ContextCompactionGateStatus {
  return {
    required: false,
    reason: null,
    status: baseContextStatus,
    recentCompaction: false,
    windowTurns: 4,
    lastCompactionTurn: null,
    turnsSinceCompaction: null,
    ...input,
  };
}

function materializationInput(input: Partial<MaterializationInput> = {}): MaterializationInput {
  return {
    sessionId: "session-1",
    turn: 3,
    contextScopeId: "scope-1",
    systemPrompt: "System prompt",
    rendered: {
      blocks: [{ id: "active-workbench", content: "Workbench", estimatedTokens: 1 }],
      content: "Workbench",
      totalTokens: 1,
      surfacedDelegationRunIds: [],
    },
    usage: undefined,
    gateStatus: gateStatus({}),
    pendingCompactionReason: null,
    workbenchContextRendered: false,
    capabilityDisclosureRendered: false,
    consequenceDigestRendered: false,
    surfacedDelegationRunIds: [],
    ...input,
  };
}

describe("hosted context materialization", () => {
  test("plans hard-gate materialization commands in the committed order", () => {
    const plan = planHostedContextMaterialization(
      materializationInput({
        gateStatus: gateStatus({ required: true, reason: "hard_limit" }),
        pendingCompactionReason: "hard_limit",
        capabilityDisclosureRendered: true,
        workbenchContextRendered: true,
        surfacedDelegationRunIds: ["run-1"],
        consequenceDigestRendered: true,
      }),
    );
    const effects = plan.effects.map((entry) => entry.effect);

    expect(effects).toEqual([
      "usage_observed",
      "hard_gate_telemetry_emitted",
      "compaction_nudge_rendered",
      "context_composed_emitted",
      "telemetry_emitted",
      "capability_disclosure_rendered",
      "consequence_digest_rendered",
      "workbench_context_rendered",
      "prompt_stability_observed",
      "delegation_outcome_surfaced",
    ]);
    expect(effects).toEqual(
      effects.toSorted(
        (left, right) =>
          HOSTED_CONTEXT_MATERIALIZATION_EFFECT_ORDER.indexOf(left) -
          HOSTED_CONTEXT_MATERIALIZATION_EFFECT_ORDER.indexOf(right),
      ),
    );
    expect(plan.modelContext.systemPrompt).toBe("System prompt");
    expect(plan.audit).toEqual({
      sessionId: "session-1",
      turn: 3,
      effectCount: effects.length,
      renderedBlockIds: ["active-workbench"],
    });
  });

  test("plans advisory materialization commands without hard-gate telemetry", () => {
    const effects = planHostedContextMaterialization(
      materializationInput({
        gateStatus: gateStatus({ required: false, reason: "usage_threshold" }),
        pendingCompactionReason: "usage_threshold",
        capabilityDisclosureRendered: false,
        workbenchContextRendered: false,
        surfacedDelegationRunIds: [],
      }),
    ).effects.map((entry) => entry.effect);

    expect(effects).toEqual([
      "usage_observed",
      "compaction_advisory_telemetry_emitted",
      "compaction_nudge_rendered",
      "context_composed_emitted",
      "telemetry_emitted",
      "prompt_stability_observed",
    ]);
  });

  test("rejects manually supplied materialization plans that violate committed order", () => {
    const plan = planHostedContextMaterialization(materializationInput());
    const prompt = plan.effects.find((entry) => entry.effect === "prompt_stability_observed");
    const context = plan.effects.find((entry) => entry.effect === "context_composed_emitted");

    expect(() =>
      commitHostedContextMaterialization(
        { ...plan, effects: [prompt, context] as never },
        { runtime: {} as never },
      ),
    ).toThrow("Hosted context materialization plan is out of order");
  });

  test("rejects manually supplied materialization plans that repeat an effect", () => {
    const plan = planHostedContextMaterialization(materializationInput());
    const usage = plan.effects[0];

    expect(() =>
      commitHostedContextMaterialization(
        { ...plan, effects: [usage, usage] as never },
        { runtime: {} as never },
      ),
    ).toThrow("Hosted context materialization plan has duplicate effect");
  });

  test("rejects unsupported command pairs before side effects run", () => {
    const plan = planHostedContextMaterialization(materializationInput());
    const usage = plan.effects[0];
    const runtime = {
      operator: {
        context: {
          usage: {
            observe() {
              throw new Error("side effect ran");
            },
          },
        },
      },
    };

    expect(() =>
      commitHostedContextMaterialization(
        {
          ...plan,
          effects: [{ ...usage, command: "unsupported_command" }] as never,
        },
        { runtime: runtime as never },
      ),
    ).toThrow("Hosted context materialization plan has unsupported command");
  });

  test("rejects unsupported effects before side effects run", () => {
    const plan = planHostedContextMaterialization(materializationInput());
    const runtime = {
      operator: {
        context: {
          usage: {
            observe() {
              throw new Error("side effect ran");
            },
          },
        },
      },
    };

    expect(() =>
      commitHostedContextMaterialization(
        {
          ...plan,
          effects: [
            {
              effect: "unknown_effect",
              command: "observe_usage",
              payload: {
                sessionId: "session-1",
              },
            },
          ] as never,
        },
        { runtime: runtime as never },
      ),
    ).toThrow("Hosted context materialization plan has unsupported effect");
  });
});
