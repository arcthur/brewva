import type { BrewvaRuntime, ContextCompactionGateStatus } from "@brewva/brewva-runtime";
import { CONTEXT_COMPOSED_EVENT_TYPE } from "@brewva/brewva-runtime";
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

export function createHostedContextTelemetry(runtime: BrewvaRuntime): HostedContextTelemetry {
  const emitRuntimeEvent = (input: {
    sessionId: string;
    turn: number;
    type: string;
    payload: Record<string, unknown>;
  }): void => {
    runtime.events.record({
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
        type: "context_compaction_skipped",
        payload: {
          reason: input.reason,
        },
      });
    },
    emitAutoRequested(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: "context_compaction_auto_requested",
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
        type: "context_compaction_auto_completed",
        payload: {
          reason: input.reason,
        },
      });
    },
    emitAutoFailed(input) {
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: "context_compaction_auto_failed",
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
        type: "context_compaction_gate_armed",
        payload: {
          reason: input.reason,
          usagePercent: input.gateStatus.pressure.usageRatio,
          hardLimitPercent: input.gateStatus.pressure.hardLimitRatio,
        },
      });
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: "critical_without_compact",
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
        type: "context_compaction_advisory",
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
        type: "session_compact",
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
        type: "context_compaction_gate_cleared",
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
