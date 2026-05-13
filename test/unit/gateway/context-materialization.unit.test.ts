import { describe, expect, test } from "bun:test";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-runtime/context";
import {
  commitHostedContextEffects,
  HOSTED_CONTEXT_SIDE_EFFECT_ORDER,
  planHostedContextEffects,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/materialization.js";

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

describe("hosted context materialization", () => {
  test("plans hard-gate side effects in the committed order", () => {
    const plan = planHostedContextEffects({
      gateStatus: gateStatus({ required: true, reason: "hard_limit" }),
      pendingCompactionReason: "hard_limit",
      capabilityDisclosureRendered: true,
      workbenchContextRendered: true,
      surfacedDelegationRunIds: ["run-1"],
    }).map((entry) => entry.effect);

    expect(plan).toEqual([
      "usage_observed",
      "hard_gate_telemetry_emitted",
      "compaction_nudge_rendered",
      "context_composed_emitted",
      "telemetry_emitted",
      "capability_disclosure_rendered",
      "workbench_context_rendered",
      "prompt_stability_observed",
      "delegation_outcome_surfaced",
    ]);
    expect(plan).toEqual(
      plan.toSorted(
        (left, right) =>
          HOSTED_CONTEXT_SIDE_EFFECT_ORDER.indexOf(left) -
          HOSTED_CONTEXT_SIDE_EFFECT_ORDER.indexOf(right),
      ),
    );
  });

  test("plans advisory side effects without hard-gate telemetry", () => {
    const plan = planHostedContextEffects({
      gateStatus: gateStatus({ required: false, reason: "usage_threshold" }),
      pendingCompactionReason: "usage_threshold",
      capabilityDisclosureRendered: false,
      workbenchContextRendered: false,
      surfacedDelegationRunIds: [],
    }).map((entry) => entry.effect);

    expect(plan).toEqual([
      "usage_observed",
      "compaction_advisory_telemetry_emitted",
      "compaction_nudge_rendered",
      "context_composed_emitted",
      "telemetry_emitted",
      "prompt_stability_observed",
    ]);
  });

  test("rejects manually supplied side-effect plans that violate committed order", () => {
    expect(() =>
      commitHostedContextEffects(
        [{ effect: "prompt_stability_observed" }, { effect: "context_composed_emitted" }],
        {} as never,
      ),
    ).toThrow("Hosted context side-effect plan is out of order");
  });

  test("rejects manually supplied side-effect plans that repeat an effect", () => {
    expect(() =>
      commitHostedContextEffects(
        [{ effect: "usage_observed" }, { effect: "usage_observed" }],
        {} as never,
      ),
    ).toThrow("Hosted context side-effect plan has duplicate effect");
  });
});
