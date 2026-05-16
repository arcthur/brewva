import { describe, expect, test } from "bun:test";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-runtime/context";
import { materializeHostedContext } from "../../../packages/brewva-gateway/src/hosted/internal/context/materialization.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

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

function createTelemetry() {
  const calls: string[] = [];
  return {
    calls,
    telemetry: {
      emitHardGateRequired: () => calls.push("hard"),
      emitCompactionAdvisory: () => calls.push("advisory"),
      emitContextComposed: () => calls.push("composed"),
      emitAutoSkipped: () => calls.push("auto_skipped"),
      emitAutoRequested: () => calls.push("auto_requested"),
      emitAutoCompleted: () => calls.push("auto_completed"),
      emitAutoFailed: () => calls.push("auto_failed"),
      normalizeRuntimeError: (error: unknown) => String(error),
      emitGateCleared: () => calls.push("gate_cleared"),
      emitCompactionSkipped: () => calls.push("compaction_skipped"),
      emitSessionCompact: () => calls.push("session_compact"),
    },
  };
}

describe("hosted context materialization", () => {
  test("applies direct lifecycle side effects and records prompt evidence", () => {
    const runtime = createRuntimeFixture();
    const { calls, telemetry } = createTelemetry();

    const result = materializeHostedContext({
      runtime,
      telemetry,
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
      gateStatus: gateStatus({ required: true, reason: "hard_limit" }),
      pendingCompactionReason: "hard_limit",
      workbenchContextRendered: true,
      surfacedDelegationRunIds: [],
    });

    expect(result.effects).toContain("usage_observed");
    expect(result.effects).toContain("prompt_stability_observed");
    expect(result.effects).not.toContain("capability_disclosure_rendered");
    expect(result.effects).not.toContain("consequence_digest_rendered");
    expect(result.effects).not.toContain("workbench_context_rendered");
    expect(calls).toEqual(["hard", "composed"]);
    expect(runtime.inspect.context.evidence.latest("session-1", "prompt_stability")).toEqual(
      expect.objectContaining({
        kind: "prompt_stability",
        turn: 3,
      }),
    );
  });

  test("emits advisory telemetry without hard gate telemetry", () => {
    const runtime = createRuntimeFixture();
    const { calls, telemetry } = createTelemetry();

    materializeHostedContext({
      runtime,
      telemetry,
      sessionId: "session-2",
      turn: 4,
      systemPrompt: "System prompt",
      rendered: {
        blocks: [],
        content: "",
        totalTokens: 0,
        surfacedDelegationRunIds: [],
      },
      gateStatus: gateStatus({ required: false, reason: "usage_threshold" }),
      pendingCompactionReason: "usage_threshold",
      workbenchContextRendered: false,
      surfacedDelegationRunIds: [],
    });

    expect(calls).toEqual(["advisory", "composed"]);
  });
});
