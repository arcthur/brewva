import type { ContextCompactionGateStatus } from "@brewva/brewva-runtime/protocol";
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
} from "@brewva/brewva-runtime/protocol";
import type { HostedRuntimeAdapterPort } from "../session/runtime-ports.js";
import {
  buildContextComposedEventPayload,
  type HostedContextRenderResult,
} from "./hosted-context-blocks.js";

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
    rendered: HostedContextRenderResult;
    workbenchContextRendered: boolean;
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
  runtime: HostedRuntimeAdapterPort,
): HostedContextTelemetry {
  const emitRuntimeEvent = (input: {
    sessionId: string;
    turn: number;
    type: string;
    payload: Record<string, unknown>;
  }): void => {
    const event = { sessionId: input.sessionId, turn: input.turn, payload: input.payload };
    if (input.type === CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE) {
      runtime.ops.context.telemetry.compactionSkipped(event);
    } else if (input.type === CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE) {
      runtime.ops.context.telemetry.autoRequested(event);
    } else if (input.type === CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE) {
      runtime.ops.context.telemetry.autoCompleted(event);
    } else if (input.type === CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE) {
      runtime.ops.context.telemetry.autoFailed(event);
    } else if (input.type === CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE) {
      runtime.ops.context.telemetry.hardGateRequired(event);
    } else if (input.type === CRITICAL_WITHOUT_COMPACT_EVENT_TYPE) {
      runtime.ops.context.telemetry.criticalWithoutCompact(event);
    } else if (input.type === CONTEXT_COMPACTION_ADVISORY_EVENT_TYPE) {
      runtime.ops.context.telemetry.compactionAdvisory(event);
    } else if (input.type === SESSION_COMPACT_EVENT_TYPE) {
      runtime.ops.context.telemetry.sessionCompact(event);
    } else if (input.type === CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE) {
      runtime.ops.context.telemetry.gateCleared(event);
    } else if (input.type === CONTEXT_COMPOSED_EVENT_TYPE) {
      runtime.ops.context.telemetry.contextComposed(event);
    }
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
          usagePercent: input.gateStatus.status.usageRatio,
          hardLimitPercent: input.gateStatus.status.hardLimitRatio,
        },
      });
      emitRuntimeEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        type: CRITICAL_WITHOUT_COMPACT_EVENT_TYPE,
        payload: {
          reason: input.reason,
          usagePercent: input.gateStatus.status.usageRatio,
          hardLimitPercent: input.gateStatus.status.hardLimitRatio,
          forcedCompaction: input.gateStatus.status.forcedCompaction,
          requiredTool: "workbench_compact",
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
          usagePercent: input.gateStatus.status.usageRatio,
          compactionThresholdPercent: input.gateStatus.status.compactionThresholdRatio,
          hardLimitPercent: input.gateStatus.status.hardLimitRatio,
          compactionAdvised: input.gateStatus.status.compactionAdvised,
          forcedCompaction: input.gateStatus.status.forcedCompaction,
          requiredTool: "workbench_compact",
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
        payload: buildContextComposedEventPayload(input.rendered, input.workbenchContextRendered),
      });
    },
    normalizeRuntimeError,
  };
}
