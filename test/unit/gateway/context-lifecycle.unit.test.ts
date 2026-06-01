import { describe, expect, test } from "bun:test";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-vocabulary/context";
import {
  createContextNudgeCadenceTracker,
  decideContextLifecycle,
  decideContextNudge,
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

describe("context lifecycle decisions", () => {
  test("centralizes pressure action, nudge cadence, auto compaction, and anchor relevance", () => {
    const tracker = createContextNudgeCadenceTracker();
    const first = decideContextLifecycle({
      sessionId: "sess_1",
      turn: 1,
      gateStatus: gate({ compactionAdvised: true }),
      pendingCompactionReason: "usage_threshold",
      continuationAnchor: {
        id: "anchor-1",
        summary: "Continue from the hosted context lifecycle extraction.",
      },
      nudge: { tracker },
      autoCompaction: {
        hasUI: true,
        idle: false,
        recoveryPosture: "idle",
        autoCompactionInFlight: false,
      },
    });

    expect(first.pressure).toMatchObject({
      action: "workbench_compact_soon",
      reason: "usage_threshold",
    });
    expect(first.nudge).toEqual({ kind: "advisory", mode: "full" });
    expect(first.autoCompaction).toEqual({
      decision: "skip",
      caller: "auto",
      reason: "agent_active_manual_compaction_unsafe",
    });
    expect(first.continuationAnchor).toMatchObject({
      include: true,
      reason: "available",
      anchorId: "anchor-1",
    });

    const second = decideContextLifecycle({
      sessionId: "sess_1",
      turn: 2,
      gateStatus: gate({ compactionAdvised: true }),
      pendingCompactionReason: "usage_threshold",
      nudge: { tracker },
    });

    expect(second.nudge).toEqual({ kind: "advisory", mode: "brief" });
  });

  test("treats hard-limit pressure as a compact-now gate and ignores checkpoint-only anchors", () => {
    const tracker = createContextNudgeCadenceTracker();
    const decision = decideContextLifecycle({
      sessionId: "sess_2",
      turn: 1,
      gateStatus: gate({ forcedCompaction: true }),
      pendingCompactionReason: null,
      continuationAnchor: { id: "checkpoint-1", name: "   " },
      nudge: { tracker },
    });

    expect(decision.pressure).toMatchObject({
      action: "workbench_compact_now",
      reason: "hard_limit",
    });
    expect(decision.nudge).toEqual({ kind: "gate", mode: "full" });
    expect(decision.continuationAnchor).toEqual({
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

    expect(
      decideContextNudge({
        sessionId: "sess_track",
        turn: 1,
        pressure,
        tracker,
      }),
    ).toEqual({ kind: "advisory", mode: "full" });
    expect(
      decideContextNudge({
        sessionId: "sess_track",
        turn: 2,
        pressure,
        tracker,
      }),
    ).toEqual({ kind: "advisory", mode: "brief" });
    expect(
      decideContextNudge({
        sessionId: "sess_track",
        turn: 3,
        pressure,
        tracker,
      }),
    ).toEqual({ kind: "advisory", mode: "full" });

    tracker.clearSession("sess_track");
    expect(
      decideContextNudge({
        sessionId: "sess_track",
        turn: 4,
        pressure,
        tracker,
      }),
    ).toEqual({ kind: "advisory", mode: "full" });
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
        compactionEligibilityDecision: "advisory_only",
        compactionEligibilityReason: "usage_threshold",
        cacheCold: false,
      }),
    ).toMatchObject({ allowed: true, detail: null, compactionAdvised: true });
  });

  test("returns transient reduction eligibility from the central lifecycle decision", () => {
    const gateStatus = gate({ compactionAdvised: true });
    const decision = decideContextLifecycle({
      sessionId: "sess_3",
      turn: 1,
      gateStatus,
      pendingCompactionReason: null,
      nudge: { enabled: false },
      transientReduction: {
        contextBudgetEnabled: true,
        usageAvailable: true,
        postureBlockReason: null,
        gateStatus,
        pendingCompactionReason: null,
        compactionEligibilityDecision: "advisory_only",
        compactionEligibilityReason: "usage_threshold",
        cacheCold: false,
      },
    });

    expect(decision.transientReduction).toEqual({
      allowed: true,
      detail: null,
      compactionAdvised: true,
      forcedCompaction: false,
      cacheCold: false,
    });
    expect(decision.nudge).toEqual({ kind: "advisory", mode: null });
  });
});
