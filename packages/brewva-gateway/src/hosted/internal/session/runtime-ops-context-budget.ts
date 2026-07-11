import { CONTEXT_CRITICAL_ALLOWED_TOOLS } from "@brewva/brewva-runtime/security";
import { isRecord } from "@brewva/brewva-std/unknown";
import {
  decideCompaction,
  deriveContextBudgetState,
  readAutoCompactionBreakerOpen,
} from "@brewva/brewva-substrate/context-budget";
import {
  CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
  coerceContextBudgetUsage,
  type ContextBudgetUsage,
} from "@brewva/brewva-vocabulary/context";
import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import { deriveAutoCompactionIneffectiveFromReceipts } from "../context/auto-compaction-ineffective.js";
import type { HostedRuntimeOpsContext } from "./runtime-ops-context.js";
import type { RuntimeCompactionRequestInput } from "./runtime-ops-port.js";

const COMPACTION_RECEIPT_EVENT_TYPES = new Set([
  "session.compact",
  "session.compaction.committed",
  "session_compact",
]);

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPayloadNumber(payload: unknown, key: string): number | null {
  if (!isRecord(payload)) return null;
  return finiteNumber((payload as Record<string, unknown>)[key]);
}

function readRequestUsage(
  input: ContextBudgetUsage | ProtocolRecord | undefined,
): ContextBudgetUsage | undefined {
  return coerceContextBudgetUsage(input);
}

export function createContextBudgetRuntimeController(ctx: HostedRuntimeOpsContext) {
  function recordDerivedState(
    sessionId: string,
    usage: ContextBudgetUsage | undefined,
  ): ReturnType<typeof deriveContextBudgetState> {
    const state = deriveState(sessionId, usage);
    if (usage) ctx.state.latestContextUsage.set(sessionId, usage);
    ctx.state.latestCompactionGateStatus.set(sessionId, state.gateStatus);
    return state;
  }

  function updateUsagePrediction(sessionId: string, usage: ContextBudgetUsage): void {
    const previous = ctx.state.latestContextUsage.get(sessionId);
    const previousTokens = finiteNumber(previous?.tokens);
    const currentTokens = finiteNumber(usage.tokens);
    if (previousTokens === null || currentTokens === null) return;
    const growth = Math.max(0, currentTokens - previousTokens);
    if (growth <= 0) return;
    const previousEma = ctx.state.contextPredictedGrowthEmaTokens.get(sessionId);
    const nextEma = previousEma === undefined ? growth : previousEma * 0.7 + growth * 0.3;
    ctx.state.contextPredictedGrowthEmaTokens.set(sessionId, nextEma);
  }

  function readCurrentTurn(sessionId: string): number | null {
    const explicit = ctx.state.contextTurnIndexes.get(sessionId);
    if (explicit !== undefined) return explicit;
    let latestTurn: number | null = null;
    for (const event of ctx.queryStructuredEvents(sessionId)) {
      const eventTurn = finiteNumber(event.turn);
      if (eventTurn !== null && (latestTurn === null || eventTurn > latestTurn)) {
        latestTurn = eventTurn;
      }
    }
    return latestTurn;
  }

  function readLastCompactionTurn(sessionId: string): number | null {
    let lastTurn: number | null = null;
    for (const event of ctx.queryStructuredEvents(sessionId)) {
      if (!COMPACTION_RECEIPT_EVENT_TYPES.has(event.type)) continue;
      const eventTurn =
        finiteNumber(event.turn) ??
        readPayloadNumber(event.payload, "sourceTurn") ??
        readPayloadNumber(event.payload, "turn");
      if (eventTurn !== null && (lastTurn === null || eventTurn > lastTurn)) {
        lastTurn = eventTurn;
      }
    }
    return lastTurn;
  }

  function deriveAutoCompactionBreakerOpen(sessionId: string): boolean {
    const events = [
      ...ctx.queryStructuredEvents(sessionId, {
        type: CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
      }),
      ...ctx.queryStructuredEvents(sessionId, {
        type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
      }),
    ];
    return readAutoCompactionBreakerOpen(events);
  }

  function deriveAutoCompactionIneffective(sessionId: string): boolean {
    return deriveAutoCompactionIneffectiveFromReceipts(
      ctx.queryStructuredEvents(sessionId, { type: "session.compaction.committed" }),
    );
  }

  function deriveState(sessionId: string, inputUsage?: ContextBudgetUsage) {
    const usage = inputUsage ?? ctx.state.latestContextUsage.get(sessionId);
    return deriveContextBudgetState({
      usage,
      config: ctx.runtime.config.infrastructure.contextBudget,
      provider: {
        predictedTurnGrowthTokensEma: ctx.state.contextPredictedGrowthEmaTokens.get(sessionId),
      },
      recentCompaction: {
        currentTurn: readCurrentTurn(sessionId),
        lastCompactionTurn: readLastCompactionTurn(sessionId),
      },
    });
  }

  function rememberPendingReason(sessionId: string, reason: string | null): void {
    if (reason) {
      ctx.state.pendingContextCompactionReasons.set(sessionId, reason);
      return;
    }
    ctx.state.pendingContextCompactionReasons.delete(sessionId);
  }

  return {
    getUsage: (sessionId: string) => ctx.state.latestContextUsage.get(sessionId),
    getStatus: (sessionId: string, usage?: ContextBudgetUsage) =>
      recordDerivedState(sessionId, usage).status,
    getRatio: (usage?: ContextBudgetUsage) =>
      typeof usage?.tokens === "number" && usage.contextWindow > 0
        ? usage.tokens / usage.contextWindow
        : null,
    observe(sessionId: string, payload?: ContextBudgetUsage) {
      // No measurement means nothing to observe; an empty receipt would only
      // fake liveness for consumers of context_usage_observed.
      if (!payload) {
        return undefined;
      }
      updateUsagePrediction(sessionId, payload);
      recordDerivedState(sessionId, payload);
      return ctx.emit(sessionId, "context_usage_observed", payload);
    },
    getGateStatus: (sessionId: string, usage?: ContextBudgetUsage) =>
      recordDerivedState(sessionId, usage).gateStatus,
    getPendingReason: (sessionId: string) =>
      ctx.state.pendingContextCompactionReasons.get(sessionId) ??
      deriveState(sessionId).pendingReason,
    getInstructions: () => ctx.runtime.config.infrastructure.contextBudget.compactionInstructions,
    getHardLimitRatio: (sessionId: string, usage?: ContextBudgetUsage) =>
      recordDerivedState(sessionId, usage).limits.hardLimitRatio,
    getThresholdRatio: (sessionId: string, usage?: ContextBudgetUsage) =>
      recordDerivedState(sessionId, usage).limits.advisoryLimitRatio,
    resolveEligibility(input: unknown) {
      const payload = ctx.readObjectPayload(input);
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "default";
      const usage = readRequestUsage(payload.usage as ProtocolRecord | undefined);
      const gateStatus = recordDerivedState(sessionId, usage).gateStatus;
      const decision = decideCompaction({
        caller: "auto",
        gateStatus,
        pendingReason: ctx.state.pendingContextCompactionReasons.get(sessionId),
        hasUI: typeof payload.hasUI === "boolean" ? payload.hasUI : undefined,
        idle: typeof payload.idle === "boolean" ? payload.idle : undefined,
        recoveryPosture: payload.recoveryPosture === "active" ? "active" : "idle",
        autoCompactionInFlight:
          typeof payload.autoCompactionInFlight === "boolean"
            ? payload.autoCompactionInFlight
            : undefined,
        autoCompactionBreakerOpen: deriveAutoCompactionBreakerOpen(sessionId),
        autoCompactionIneffective: deriveAutoCompactionIneffective(sessionId),
      });
      return {
        eligible: decision.decision === "execute",
        reason: decision.reason,
        decision: decision.decision,
      };
    },
    getWindowTurns: () =>
      Math.max(
        0,
        Math.trunc(ctx.runtime.config.infrastructure.contextBudget.compaction.minTurnsBetween),
      ),
    rememberDeferredReason(sessionId: string, reason: string | null) {
      rememberPendingReason(sessionId, reason);
      // A clear is not a deferral, and pressure checks run per provider
      // request — receipt only a newly armed reason, so the tape carries one
      // context_compaction_deferred per episode instead of null/repeat spam.
      if (!reason) {
        ctx.state.deferredCompactionReceiptReasons.delete(sessionId);
        return null;
      }
      if (ctx.state.deferredCompactionReceiptReasons.get(sessionId) === reason) {
        return null;
      }
      ctx.state.deferredCompactionReceiptReasons.set(sessionId, reason);
      return ctx.emit(sessionId, "context_compaction_deferred", { reason });
    },
    checkGate(sessionId: string, toolName: string, usage?: ContextBudgetUsage) {
      const gateStatus = recordDerivedState(sessionId, usage).gateStatus;
      const criticalTool = CONTEXT_CRITICAL_ALLOWED_TOOLS.includes(toolName);
      if (gateStatus.required === true && !criticalTool) {
        const blocked = {
          ...gateStatus,
          required: true,
          reason: "context_compaction_gate_required",
        };
        ctx.state.latestCompactionGateStatus.set(sessionId, blocked);
        return blocked;
      }
      return gateStatus;
    },
    request(sessionId: string, inputValue?: RuntimeCompactionRequestInput) {
      const payload =
        typeof inputValue === "string"
          ? { reason: inputValue }
          : inputValue && typeof inputValue === "object"
            ? inputValue
            : {};
      const payloadRecord = ctx.readObjectPayload(payload);
      const reason =
        typeof payloadRecord.reason === "string" && payloadRecord.reason.length > 0
          ? payloadRecord.reason
          : "manual";
      rememberPendingReason(sessionId, reason);
      return ctx.emit(sessionId, "session.compact.requested", { ...payloadRecord, reason });
    },
    checkAndRequest(sessionId: string, inputValue?: ContextBudgetUsage | ProtocolRecord) {
      const usage = readRequestUsage(inputValue);
      const state = recordDerivedState(sessionId, usage);
      rememberPendingReason(sessionId, state.pendingReason);
      if (state.pendingReason) {
        ctx.emit(
          sessionId,
          state.gateStatus.required
            ? "context.compaction.gate.armed"
            : "context.compaction.advisory",
          {
            reason: state.pendingReason,
            status: state.status,
          },
        );
      }
      return {
        requested: Boolean(state.pendingReason),
        required: state.gateStatus.required === true,
        reason: state.pendingReason ?? "not_required",
        status: state.status,
      };
    },
    onTurnStart(sessionId: string, turn?: number) {
      if (typeof turn === "number" && Number.isFinite(turn)) {
        ctx.state.contextTurnIndexes.set(sessionId, Math.trunc(turn));
      }
      ctx.clearStallIfProgressResumed(sessionId);
      return ctx.emit(sessionId, "turn.started", {});
    },
  };
}
