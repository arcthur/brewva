import { describe, expect, test } from "bun:test";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-runtime/protocol";
import { buildContextBundle } from "../../../packages/brewva-gateway/src/context/context-bundle.js";
import type { HostedContextRenderResult } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-context-blocks.js";
import {
  applyContextMaterializationReceipt,
  buildContextMaterializationReceipt,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/materialization.js";
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

function contextBundleFor(rendered: HostedContextRenderResult) {
  const result = buildContextBundle({
    scope: "hosted_dynamic_tail",
    blocks: rendered.blocks.map((block) => ({
      id: block.id,
      content: block.content,
      admission: "advisory",
      priority: 100,
    })),
    createdAt: 1,
  });
  if (!result.ok) {
    throw new Error(result.blocker.reason);
  }
  return result.bundle;
}

describe("hosted context materialization", () => {
  test("applies direct lifecycle side effects and records prompt evidence", () => {
    const runtime = createRuntimeFixture();
    const { calls, telemetry } = createTelemetry();
    const rendered: HostedContextRenderResult = {
      blocks: [{ id: "active-workbench", content: "Workbench", estimatedTokens: 1 }],
      content: "Workbench",
      totalTokens: 1,
      surfacedDelegationRunIds: [],
    };

    const receipt = buildContextMaterializationReceipt({
      sessionId: "session-1",
      turn: 3,
      contextScopeId: "scope-1",
      systemPrompt: "System prompt",
      contextBundle: contextBundleFor(rendered),
      rendered,
      gateStatus: gateStatus({ required: true, reason: "hard_limit" }),
      pendingCompactionReason: "hard_limit",
      workbenchContextRendered: true,
      surfacedDelegationRunIds: [],
    });
    applyContextMaterializationReceipt({ runtime, telemetry, receipt });

    expect(receipt.usageObserved).toBe(true);
    expect(receipt.telemetry).toEqual(
      expect.objectContaining({ kind: "hard_gate_required", reason: "hard_limit" }),
    );
    expect(receipt.promptStability.turn).toBe(3);
    expect(receipt.contextComposed.workbenchContextRendered).toBe(true);
    expect(calls).toEqual(["hard", "composed"]);
    expect(runtime.ops.context.evidence.latest("session-1", "prompt_stability")).toEqual(
      expect.objectContaining({
        kind: "prompt_stability",
        turn: 3,
      }),
    );
  });

  test("emits advisory telemetry without hard gate telemetry", () => {
    const runtime = createRuntimeFixture();
    const { calls, telemetry } = createTelemetry();
    const rendered: HostedContextRenderResult = {
      blocks: [],
      content: "",
      totalTokens: 0,
      surfacedDelegationRunIds: [],
    };

    const receipt = buildContextMaterializationReceipt({
      sessionId: "session-2",
      turn: 4,
      systemPrompt: "System prompt",
      contextBundle: contextBundleFor(rendered),
      rendered,
      gateStatus: gateStatus({ required: false, reason: "usage_threshold" }),
      pendingCompactionReason: "usage_threshold",
      workbenchContextRendered: false,
      surfacedDelegationRunIds: [],
    });
    applyContextMaterializationReceipt({ runtime, telemetry, receipt });

    expect(calls).toEqual(["advisory", "composed"]);
  });
});
