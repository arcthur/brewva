import { describe, expect, test } from "bun:test";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-vocabulary/context";
import { decideContinuationAnchorRelevance } from "@brewva/brewva-vocabulary/session";
import {
  createContextNudgeCadenceTracker,
  decideAutoCompactionEligibility,
  decideContextPressure,
  decideTransientReductionEligibility,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/context-lifecycle.js";

const baseStatus: ContextStatus = {
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

function gate(status: Partial<ContextStatus>): ContextCompactionGateStatus {
  return {
    required: status.forcedCompaction === true,
    reason: status.forcedCompaction
      ? "hard_limit"
      : status.predictedOverflow
        ? "predicted_overflow"
        : status.compactionAdvised
          ? "usage_threshold"
          : null,
    status: { ...baseStatus, ...status },
    recentCompaction: false,
    windowTurns: 4,
    lastCompactionTurn: null,
    turnsSinceCompaction: null,
  };
}

// These decisions used to be reachable through a single `decideContextLifecycle`
// aggregator, but production always consumed the sub-decisions piecemeal, so the
// aggregator (and its thin `decideContextNudge` wrapper) were removed. The tests
// exercise the live seams directly: `decideContextPressure`, the cadence tracker's
// `decide`, `decideAutoCompactionEligibility`, `decideTransientReductionEligibility`,
// and `decideContinuationAnchorRelevance`.
describe("context lifecycle decisions", () => {
  test("advisory pressure drives a full-then-brief nudge, an agent-active auto-compaction skip, and an available anchor", () => {
    const tracker = createContextNudgeCadenceTracker();
    const gateStatus = gate({ compactionAdvised: true });
    const pressure = decideContextPressure({
      gateStatus,
      pendingCompactionReason: "usage_threshold",
    });
    expect(pressure).toMatchObject({ action: "workbench_compact_soon", reason: "usage_threshold" });

    expect(tracker.decide({ sessionId: "sess_1", turn: 1, pressure })).toEqual({
      kind: "advisory",
      mode: "full",
    });

    expect(
      decideAutoCompactionEligibility({
        gateStatus,
        pendingCompactionReason: "usage_threshold",
        hasUI: true,
        idle: false,
        recoveryPosture: "idle",
        autoCompactionInFlight: false,
      }),
    ).toEqual({
      decision: "skip",
      caller: "auto",
      reason: "agent_active_manual_compaction_unsafe",
    });

    expect(
      decideContinuationAnchorRelevance({
        id: "anchor-1",
        summary: "Continue from the hosted context lifecycle extraction.",
      }),
    ).toMatchObject({ include: true, reason: "available", anchorId: "anchor-1" });

    // Same pressure on the next turn → the cadence demotes full → brief.
    expect(tracker.decide({ sessionId: "sess_1", turn: 2, pressure })).toEqual({
      kind: "advisory",
      mode: "brief",
    });
  });

  test("hard-limit pressure is a compact-now gate nudge and checkpoint-only anchors are excluded", () => {
    const tracker = createContextNudgeCadenceTracker();
    const pressure = decideContextPressure({
      gateStatus: gate({ forcedCompaction: true }),
      pendingCompactionReason: null,
    });
    expect(pressure).toMatchObject({ action: "workbench_compact_now", reason: "hard_limit" });
    expect(tracker.decide({ sessionId: "sess_2", turn: 1, pressure })).toEqual({
      kind: "gate",
      mode: "full",
    });
    expect(decideContinuationAnchorRelevance({ id: "checkpoint-1", name: "   " })).toEqual({
      include: false,
      reason: "checkpoint_only",
      anchorId: "checkpoint-1",
    });
  });

  test("keeps nudge cadence state in an explicit tracker and clears sessions", () => {
    const tracker = createContextNudgeCadenceTracker({ fullEveryTurns: 2 });
    const pressure = decideContextPressure({
      gateStatus: gate({ compactionAdvised: true }),
      pendingCompactionReason: "usage_threshold",
    });

    expect(tracker.decide({ sessionId: "sess_track", turn: 1, pressure })).toEqual({
      kind: "advisory",
      mode: "full",
    });
    expect(tracker.decide({ sessionId: "sess_track", turn: 2, pressure })).toEqual({
      kind: "advisory",
      mode: "brief",
    });
    expect(tracker.decide({ sessionId: "sess_track", turn: 3, pressure })).toEqual({
      kind: "advisory",
      mode: "full",
    });

    tracker.clearSession("sess_track");
    expect(tracker.decide({ sessionId: "sess_track", turn: 4, pressure })).toEqual({
      kind: "advisory",
      mode: "full",
    });
  });

  test("a disabled nudge yields the pressure kind with a null mode", () => {
    const tracker = createContextNudgeCadenceTracker();
    const pressure = decideContextPressure({
      gateStatus: gate({ compactionAdvised: true }),
      pendingCompactionReason: null,
    });
    expect(
      tracker.decide({ sessionId: "sess_disabled", turn: 1, pressure, enabled: false }),
    ).toEqual({ kind: "advisory", mode: null });
  });

  test("keeps transient reduction behind replay-visible compaction at hard limits", () => {
    expect(
      decideTransientReductionEligibility({
        contextBudgetEnabled: true,
        usageAvailable: true,
        postureBlockReason: null,
        gateStatus: gate({ forcedCompaction: true }),
        pendingCompactionReason: null,
        compactionEligibilityDecision: "execute",
        compactionEligibilityReason: "hard_limit",
        cacheCold: false,
      }),
    ).toEqual({
      allowed: false,
      detail: "hard-limit posture requires replay-visible compaction handling",
      compactionAdvised: false,
      forcedCompaction: true,
      cacheCold: false,
    });

    expect(
      decideTransientReductionEligibility({
        contextBudgetEnabled: true,
        usageAvailable: true,
        postureBlockReason: null,
        gateStatus: gate({ compactionAdvised: true }),
        pendingCompactionReason: null,
        compactionEligibilityDecision: "execute",
        compactionEligibilityReason: "usage_threshold",
        cacheCold: false,
      }),
    ).toMatchObject({ allowed: true, detail: null, compactionAdvised: true });
  });

  test("allows transient reduction when the current provider payload predicts overflow", () => {
    expect(
      decideTransientReductionEligibility({
        contextBudgetEnabled: true,
        usageAvailable: true,
        usageSource: "provider_payload",
        postureBlockReason: null,
        gateStatus: gate({ compactionAdvised: true, predictedOverflow: true }),
        pendingCompactionReason: null,
        compactionEligibilityDecision: "execute",
        compactionEligibilityReason: "predicted_overflow",
        cacheCold: false,
      }),
    ).toEqual({
      allowed: true,
      detail: null,
      compactionAdvised: true,
      forcedCompaction: false,
      cacheCold: false,
    });
  });

  test("allows transient reduction at hard limits when the current provider payload is the pressure source", () => {
    expect(
      decideTransientReductionEligibility({
        contextBudgetEnabled: true,
        usageAvailable: true,
        usageSource: "provider_payload",
        postureBlockReason: null,
        gateStatus: gate({ forcedCompaction: true }),
        pendingCompactionReason: null,
        compactionEligibilityDecision: "execute",
        compactionEligibilityReason: "hard_limit",
        cacheCold: false,
      }),
    ).toEqual({
      allowed: true,
      detail: null,
      compactionAdvised: false,
      forcedCompaction: true,
      cacheCold: false,
    });
  });

  test("allows provider-payload reduction even when recovery posture is active", () => {
    expect(
      decideTransientReductionEligibility({
        contextBudgetEnabled: true,
        usageAvailable: true,
        usageSource: "provider_payload",
        postureBlockReason: "recovery posture is active",
        gateStatus: gate({ forcedCompaction: true }),
        pendingCompactionReason: "hard_limit",
        compactionEligibilityDecision: "execute",
        compactionEligibilityReason: "hard_limit",
        cacheCold: false,
      }),
    ).toEqual({
      allowed: true,
      detail: null,
      compactionAdvised: false,
      forcedCompaction: true,
      cacheCold: false,
    });
  });
});
