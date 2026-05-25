import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { RuntimeCompactionRequestInput } from "../runtime-ops-port.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildContextRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["context"] {
  return {
    usage: {
      get: (): typeof ctx.emptyContextUsage | undefined => ctx.emptyContextUsage,
      getStatus: () => ctx.emptyContextStatus,
      getRatio: () => null,
      observe: ctx.recordSessionPayload("context_usage_observed"),
    },
    compaction: {
      getGateStatus: () => ctx.emptyCompactionGateStatus,
      getPendingReason: () => null,
      getInstructions: () => "",
      getHardLimitRatio: () => ctx.emptyContextStatus.hardLimitRatio ?? 1,
      getThresholdRatio: () => ctx.emptyContextStatus.compactionThresholdRatio ?? 1,
      resolveEligibility: () => ({
        eligible: false,
        reason: "disabled",
        decision: "skip",
      }),
      getWindowTurns: () => 0,
      rememberDeferredReason(sessionId, reason) {
        return ctx.emit(sessionId, "context_compaction_deferred", { reason });
      },
      checkGate: () => ctx.emptyCompactionGateStatus,
      request(sessionId, inputValue?: RuntimeCompactionRequestInput) {
        const payload =
          typeof inputValue === "string"
            ? { reason: inputValue }
            : inputValue && typeof inputValue === "object"
              ? inputValue
              : {};
        return ctx.emit(sessionId, "checkpoint.committed", payload);
      },
      checkAndRequest: () => ({
        requested: false,
        required: false,
        reason: "not_required",
        status: ctx.emptyContextStatus,
      }),
    },
    evidence: {
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
        return ctx.emit(sessionId, "context_evidence_appended", payload);
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
      onTurnStart(sessionId) {
        ctx.clearStallIfProgressResumed(sessionId);
        return ctx.emit(sessionId, "turn.started", {});
      },
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
      gateCleared: ctx.recordInputPayload("context.compaction.gate.cleared"),
      hardGateRequired: ctx.recordInputPayload("context.compaction.gate.armed"),
      sessionCompact: ctx.recordInputPayload("session.compact"),
    },
  };
}
