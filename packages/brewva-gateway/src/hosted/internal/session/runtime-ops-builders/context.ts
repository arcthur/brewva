import { CONTEXT_EVIDENCE_APPENDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/harness";
import { SESSION_PRE_COMPACT_PRUNE_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import { createContextBudgetRuntimeController } from "../runtime-ops-context-budget.js";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildContextRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["context"] {
  const budget = createContextBudgetRuntimeController(ctx);

  return {
    usage: {
      get: (sessionId) => budget.getUsage(sessionId),
      getStatus: (sessionId, usage) => budget.getStatus(sessionId, usage),
      getRatio: (usage) => budget.getRatio(usage),
      observe: (sessionId, payload) => budget.observe(sessionId, payload),
    },
    compaction: {
      getGateStatus: (sessionId, usage) => budget.getGateStatus(sessionId, usage),
      getPendingReason: (sessionId) => budget.getPendingReason(sessionId),
      getInstructions: () => budget.getInstructions(),
      getHardLimitRatio: (sessionId, usage) => budget.getHardLimitRatio(sessionId, usage),
      getThresholdRatio: (sessionId, usage) => budget.getThresholdRatio(sessionId, usage),
      resolveEligibility: (input) => budget.resolveEligibility(input),
      getWindowTurns: () => budget.getWindowTurns(),
      rememberDeferredReason: (sessionId, reason) =>
        budget.rememberDeferredReason(sessionId, reason),
      checkGate: (sessionId, toolName, usage) => budget.checkGate(sessionId, toolName, usage),
      request: (sessionId, inputValue) => budget.request(sessionId, inputValue),
      checkAndRequest: (sessionId, inputValue) => budget.checkAndRequest(sessionId, inputValue),
    },
    evidence: {
      // Context evidence is intentionally lossy in-memory performance state
      // (latest-per-kind, not replay-derived): it does not survive a restart by
      // design (see context-evidence-latest.unit.test.ts), unlike the
      // tape-authoritative workbench/task/lease/worker-result state.
      latest(sessionId, kind) {
        return ctx.state.latestContextEvidence.get(sessionId)?.get(kind);
      },
      append(sessionId, payload) {
        const record = ctx.readObjectPayload(payload);
        const kind = typeof record.kind === "string" ? record.kind : undefined;
        const samplePayload = ctx.readObjectPayload(record.payload);
        if (kind) {
          const sessionEvidence = ctx.state.latestContextEvidence.get(sessionId) ?? new Map();
          sessionEvidence.set(kind, {
            kind,
            turn: typeof record.turn === "number" ? record.turn : 0,
            timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
            payload: samplePayload,
          });
          ctx.state.latestContextEvidence.set(sessionId, sessionEvidence);
        }
        return ctx.emit(sessionId, CONTEXT_EVIDENCE_APPENDED_EVENT_TYPE, payload);
      },
    },
    prompt: {
      getHistoryViewBaseline: () => undefined,
    },
    visibleRead: {
      getEpoch: () => 0,
      isCurrent: () => true,
      rememberState: ctx.recordSessionPayload("context_visible_read_state_remembered"),
    },
    sanitizeInput: (text: string) => text,
    lifecycle: {
      onUserInput: ctx.recordSessionPayload("context_user_input"),
      onTurnStart: (sessionId, turn) => budget.onTurnStart(sessionId, turn),
      onTurnEnd: ctx.recordSessionPayload("turn.ended"),
    },
    telemetry: {
      autoCompleted: ctx.recordInputPayload("context.compaction.auto.completed"),
      autoFailed: ctx.recordInputPayload("context.compaction.auto.failed"),
      autoRequested: ctx.recordInputPayload("context.compaction.auto.requested"),
      compactionAdvisory: ctx.recordInputPayload("context.compaction.advisory"),
      compactionSkipped: ctx.recordInputPayload("context.compaction.skipped"),
      contextComposed: ctx.recordInputPayload("context.composed"),
      criticalWithoutCompact: ctx.recordInputPayload("context.critical_without_compact"),
      gateCleared(inputValue) {
        const { sessionId, timestamp, turn, payload, ...rest } = inputValue;
        const resolvedSessionId = typeof sessionId === "string" ? sessionId : "default";
        ctx.state.pendingContextCompactionReasons.delete(resolvedSessionId);
        ctx.state.latestCompactionGateStatus.delete(resolvedSessionId);
        const eventPayload =
          payload && typeof payload === "object" && !Array.isArray(payload) ? payload : rest;
        return ctx.emit(resolvedSessionId, "context.compaction.gate.cleared", eventPayload, {
          timestamp: typeof timestamp === "number" ? timestamp : undefined,
          turn: typeof turn === "number" ? turn : undefined,
        });
      },
      hardGateRequired: ctx.recordInputPayload("context.compaction.gate.armed"),
      preCompactPrune: ctx.recordInputPayload(SESSION_PRE_COMPACT_PRUNE_EVENT_TYPE),
      sessionCompact: ctx.recordInputPayload("session.compact"),
    },
  };
}
