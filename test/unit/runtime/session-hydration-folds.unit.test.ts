import { describe, expect, test } from "bun:test";
import type {
  BrewvaEventRecord,
  IntegrityIssue,
  VerificationSessionState,
} from "../../../packages/brewva-runtime/src/contracts/index.js";
import {
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "../../../packages/brewva-runtime/src/events/event-types.js";
import { createCostHydrationFold } from "../../../packages/brewva-runtime/src/services/session-hydration-fold-cost.js";
import { createLedgerHydrationFold } from "../../../packages/brewva-runtime/src/services/session-hydration-fold-ledger.js";
import { createResourceLeaseHydrationFold } from "../../../packages/brewva-runtime/src/services/session-hydration-fold-resource-lease.js";
import { createSkillHydrationFold } from "../../../packages/brewva-runtime/src/services/session-hydration-fold-skill.js";
import { createVerificationHydrationFold } from "../../../packages/brewva-runtime/src/services/session-hydration-fold-verification.js";
import {
  applySessionHydrationFold,
  type SessionHydrationApplyContext,
  type SessionHydrationFold,
  type SessionHydrationFoldCallbacks,
  type SessionHydrationFoldContext,
} from "../../../packages/brewva-runtime/src/services/session-hydration-fold.js";
import { RuntimeSessionStateCell } from "../../../packages/brewva-runtime/src/services/session-state.js";
import type { JsonValue } from "../../../packages/brewva-runtime/src/utils/json.js";
import {
  buildVerificationToolResultProjectionPayload,
  buildVerificationWriteMarkedPayload,
} from "../../../packages/brewva-runtime/src/verification/projector-payloads.js";

function createEvent(input: {
  id: string;
  type: string;
  timestamp: number;
  turn?: number;
  payload?: Record<string, unknown>;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: "session-hydration-folds",
    type: input.type,
    timestamp: input.timestamp,
    turn: input.turn,
    payload: input.payload as Record<string, JsonValue> | undefined,
  };
}

function runFold<State>(
  fold: SessionHydrationFold<State>,
  events: BrewvaEventRecord[],
  options: {
    replayCheckpointTurnTransient?: boolean;
  } = {},
): {
  cell: RuntimeSessionStateCell;
  issues: IntegrityIssue[];
  costReplayCalls: Array<{
    eventId: string;
    checkpointTurnTransient: boolean;
  }>;
  verificationSnapshots: Array<VerificationSessionState | undefined>;
} {
  const cell = new RuntimeSessionStateCell();
  const issues: IntegrityIssue[] = [];
  const costReplayCalls: Array<{
    eventId: string;
    checkpointTurnTransient: boolean;
  }> = [];
  const verificationSnapshots: Array<VerificationSessionState | undefined> = [];
  const callbacks: SessionHydrationFoldCallbacks = {
    replayCostStateEvent: (_sessionId, event, _payload, replayOptions) => {
      costReplayCalls.push({
        eventId: event.id,
        checkpointTurnTransient: replayOptions.checkpointTurnTransient,
      });
    },
    restoreVerificationState: (_sessionId, snapshot) => {
      verificationSnapshots.push(snapshot);
    },
  };
  const state = fold.initial(cell);

  for (const [index, event] of events.entries()) {
    const context: SessionHydrationFoldContext = {
      sessionId: event.sessionId,
      index,
      replayCostTail: true,
      replayCheckpointTurnTransient: options.replayCheckpointTurnTransient === true,
      callbacks,
      issues,
    };
    applySessionHydrationFold(fold, state, event, context);
  }

  const applyContext: SessionHydrationApplyContext = {
    sessionId: "session-hydration-folds",
    callbacks,
  };
  fold.apply(state, cell, applyContext);

  return {
    cell,
    issues,
    costReplayCalls,
    verificationSnapshots,
  };
}

describe("session hydration folds", () => {
  test("skill fold restores active skill, call count, and governance warning dedupe state", () => {
    const result = runFold(createSkillHydrationFold(), [
      createEvent({
        id: "skill-1",
        type: "skill_activated",
        timestamp: 100,
        turn: 1,
        payload: { skillName: "design" },
      }),
      createEvent({
        id: "skill-2",
        type: "tool_call_marked",
        timestamp: 110,
        turn: 1,
        payload: { toolName: "custom_query_tool", toolCalls: 1 },
      }),
      createEvent({
        id: "skill-3",
        type: "governance_metadata_missing",
        timestamp: 120,
        turn: 1,
        payload: {
          skill: "design",
          toolName: "custom_query_tool",
          resolution: "hint",
        },
      }),
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.cell.activeSkill).toBe("design");
    expect(result.cell.toolCalls).toBe(1);
    expect([...result.cell.governanceMetadataWarnings]).toEqual(["design:custom_query_tool"]);
  });

  test("verification fold restores write markers, evidence, and check runs", () => {
    const result = runFold(createVerificationHydrationFold(), [
      createEvent({
        id: "verification-1",
        type: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
        timestamp: 200,
        turn: 2,
        payload: buildVerificationWriteMarkedPayload({ toolName: "edit" }),
      }),
      createEvent({
        id: "verification-2",
        type: TOOL_RESULT_RECORDED_EVENT_TYPE,
        timestamp: 210,
        turn: 2,
        payload: {
          verificationProjection: buildVerificationToolResultProjectionPayload({
            now: 210,
            toolName: "lsp_diagnostics",
            args: {},
            outputText: "No diagnostics found",
            verdict: "pass",
            ledgerId: "ledger-lsp-clean",
            outputSummary: "clean",
          }),
        },
      }),
      createEvent({
        id: "verification-3",
        type: TOOL_RESULT_RECORDED_EVENT_TYPE,
        timestamp: 220,
        turn: 2,
        payload: {
          verificationProjection: buildVerificationToolResultProjectionPayload({
            now: 220,
            toolName: "brewva_verify",
            args: {},
            outputText: "ok",
            verdict: "pass",
            ledgerId: "ledger-verify",
            outputSummary: "verify ok",
            metadata: {
              check: "typecheck",
              command: "bun run check",
              exitCode: 0,
              durationMs: 42,
            },
          }),
        },
      }),
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.verificationSnapshots).toHaveLength(1);
    expect(result.verificationSnapshots[0]).toMatchObject({
      lastWriteAt: 200,
      denialCount: 0,
    });
    expect(result.verificationSnapshots[0]?.evidence).toHaveLength(1);
    expect(result.verificationSnapshots[0]?.checkRuns.typecheck).toMatchObject({
      ok: true,
      command: "bun run check",
      ledgerId: "ledger-verify",
    });
  });

  test("verification fold honors reset events", () => {
    const result = runFold(createVerificationHydrationFold(), [
      createEvent({
        id: "verification-reset-1",
        type: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
        timestamp: 300,
        turn: 3,
        payload: buildVerificationWriteMarkedPayload({ toolName: "edit" }),
      }),
      createEvent({
        id: "verification-reset-2",
        type: VERIFICATION_STATE_RESET_EVENT_TYPE,
        timestamp: 310,
        turn: 3,
        payload: { reason: "rollback" },
      }),
    ]);

    expect(result.verificationSnapshots).toEqual([undefined]);
  });

  test("resource lease fold restores and updates lease lifecycle state", () => {
    const result = runFold(createResourceLeaseHydrationFold(), [
      createEvent({
        id: "lease-1",
        type: RESOURCE_LEASE_GRANTED_EVENT_TYPE,
        timestamp: 400,
        turn: 4,
        payload: {
          id: "lease-1",
          sessionId: "session-hydration-folds",
          skillName: "implementation",
          reason: "need more room",
          budget: {
            maxToolCalls: 2,
          },
          createdAt: 400,
          expiresAfterTurn: 6,
          status: "active",
        },
      }),
      createEvent({
        id: "lease-2",
        type: RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
        timestamp: 410,
        turn: 4,
        payload: {
          leaseId: "lease-1",
          status: "cancelled",
          cancelledAt: 410,
          cancelledReason: "operator override",
        },
      }),
    ]);

    const lease = result.cell.resourceLeases.get("lease-1");
    expect(lease).toMatchObject({
      status: "cancelled",
      cancelledAt: 410,
      cancelledReason: "operator override",
      budget: {
        maxToolCalls: 2,
      },
    });
  });

  test("cost fold dispatches checkpoint-aware replay callbacks", () => {
    const fold = createCostHydrationFold();
    const cell = new RuntimeSessionStateCell();
    const state = fold.initial(cell);
    const issues: IntegrityIssue[] = [];
    const costReplayCalls: Array<{
      eventId: string;
      checkpointTurnTransient: boolean;
    }> = [];
    const callbacks: SessionHydrationFoldCallbacks = {
      replayCostStateEvent: (_sessionId, event, _payload, replayOptions) => {
        costReplayCalls.push({
          eventId: event.id,
          checkpointTurnTransient: replayOptions.checkpointTurnTransient,
        });
      },
      restoreVerificationState: () => {},
    };

    applySessionHydrationFold(
      fold,
      state,
      createEvent({
        id: "cost-1",
        type: "tool_call_marked",
        timestamp: 500,
        turn: 5,
        payload: { toolName: "grep" },
      }),
      {
        sessionId: "session-hydration-folds",
        index: 0,
        replayCostTail: false,
        replayCheckpointTurnTransient: true,
        callbacks,
        issues,
      },
    );
    applySessionHydrationFold(
      fold,
      state,
      createEvent({
        id: "cost-2",
        type: "cost_update",
        timestamp: 510,
        turn: 5,
        payload: { totalTokens: 12, costUsd: 0.001 },
      }),
      {
        sessionId: "session-hydration-folds",
        index: 1,
        replayCostTail: false,
        replayCheckpointTurnTransient: false,
        callbacks,
        issues,
      },
    );
    applySessionHydrationFold(
      fold,
      state,
      createEvent({
        id: "cost-3",
        type: "cost_update",
        timestamp: 520,
        turn: 6,
        payload: { totalTokens: 8, costUsd: 0.0008 },
      }),
      {
        sessionId: "session-hydration-folds",
        index: 2,
        replayCostTail: true,
        replayCheckpointTurnTransient: false,
        callbacks,
        issues,
      },
    );

    expect(costReplayCalls).toEqual([
      {
        eventId: "cost-1",
        checkpointTurnTransient: true,
      },
      {
        eventId: "cost-3",
        checkpointTurnTransient: false,
      },
    ]);
  });

  test("ledger fold restores the latest compaction turn", () => {
    const result = runFold(createLedgerHydrationFold(), [
      createEvent({
        id: "ledger-1",
        type: "ledger_compacted",
        timestamp: 600,
        turn: 6,
        payload: {
          compacted: 12,
          kept: 4,
          checkpointId: "checkpoint-1",
        },
      }),
    ]);

    expect(result.cell.lastLedgerCompactionTurn).toBe(6);
  });
});
