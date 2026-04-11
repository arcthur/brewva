import type { BrewvaHostedRuntimePort, ContextCompactionGateStatus } from "@brewva/brewva-runtime";
import {
  CONTEXT_COMPACTION_ADVISORY_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE,
  CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
  CONTEXT_COMPOSED_EVENT_TYPE,
  CRITICAL_WITHOUT_COMPACT_EVENT_TYPE,
  SESSION_COMPACT_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  buildContextComposedEventPayload,
  type ContextComposerResult,
} from "./context-composer.js";

export const AUTO_COMPACTION_WATCHDOG_ERROR = "auto_compaction_watchdog_timeout";

export interface HostedContextTelemetry {
  emitCompactionSkipped: (input: { sessionId: string; turn: number; reason: string }) => void;
  emitAutoRequested: (input: {
    sessionId: string;
    turn: number;
    reason: string;
    usagePercent: number | null | undefined;
    tokens: number | null;
  }) => void;
  emitAutoCompleted: (input: { sessionId: string; turn: number; reason: string }) => void;
  emitAutoFailed: (input: {
    sessionId: string;
    turn: number;
    reason: string;
    error: string;
    watchdogMs?: number;
  }) => void;
  emitHardGateRequired: (input: {
    sessionId: string;
    turn: number;
    reason: "hard_limit";
    gateStatus: ContextCompactionGateStatus;
  }) => void;
  emitCompactionAdvisory: (input: {
    sessionId: string;
    turn: number;
    reason: string;
    gateStatus: ContextCompactionGateStatus;
  }) => void;
  emitSessionCompact: (input: {
    sessionId: string;
    turn: number;
    entryId: string | null;
    fromExtension?: true;
  }) => void;
  emitGateCleared: (input: { sessionId: string; turn: number; reason: string }) => void;
  emitContextComposed: (input: {
    sessionId: string;
    turn: number;
    composed: ContextComposerResult;
    injectionAccepted: boolean;
  }) => void;
  normalizeRuntimeError: (error: unknown) => string;
}

function normalizeRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "unknown_error";
}

export function createHostedContextTelemetry(
  runtime: BrewvaHostedRuntimePort,
): HostedContextTelemetry {
  const emitRuntimeEvent = (input: {
    sessionId: string;
    turn: number;
    type: string;
    payload: Record<string, unknown>;
  }): void => {
    recordRuntimeEvent(runtime, {
      sessionId: input.sessionId,
      turn: input.turn,
      type: input.type,
      payload: input.payload,
    });
  };

  return {
    emitCompactionSkipped(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
        payload: {
          reason: input.reason,
        },
      });
    },
    emitAutoRequested(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
        payload: {
          reason: input.reason,
          usagePercent: input.usagePercent,
          tokens: input.tokens,
        },
      });
    },
    emitAutoCompleted(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
        payload: {
          reason: input.reason,
        },
      });
    },
    emitAutoFailed(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
        payload: {
          reason: input.reason,
          error: input.error,
          watchdogMs: input.watchdogMs,
        },
      });
    },
    emitHardGateRequired(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE,
        payload: {
          reason: input.reason,
          usagePercent: input.gateStatus.pressure.usageRatio,
          hardLimitPercent: input.gateStatus.pressure.hardLimitRatio,
        },
      });
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CRITICAL_WITHOUT_COMPACT_EVENT_TYPE,
        payload: {
          reason: input.reason,
          usagePercent: input.gateStatus.pressure.usageRatio,
          hardLimitPercent: input.gateStatus.pressure.hardLimitRatio,
          contextPressure: input.gateStatus.pressure.level,
          requiredTool: "session_compact",
        },
      });
    },
    emitCompactionAdvisory(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CONTEXT_COMPACTION_ADVISORY_EVENT_TYPE,
        payload: {
          reason: input.reason,
          usagePercent: input.gateStatus.pressure.usageRatio,
          compactionThresholdPercent: input.gateStatus.pressure.compactionThresholdRatio,
          hardLimitPercent: input.gateStatus.pressure.hardLimitRatio,
          contextPressure: input.gateStatus.pressure.level,
          requiredTool: "session_compact",
        },
      });
    },
    emitSessionCompact(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: SESSION_COMPACT_EVENT_TYPE,
        payload: {
          entryId: input.entryId,
          fromExtension: input.fromExtension,
        },
      });
    },
    emitGateCleared(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE,
        payload: {
          reason: input.reason,
        },
      });
    },
    emitContextComposed(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CONTEXT_COMPOSED_EVENT_TYPE,
        payload: buildContextComposedEventPayload(input.composed, input.injectionAccepted),
      });
    },
    normalizeRuntimeError,
  };
}
