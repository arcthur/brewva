import {
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  buildTaskStallAdjudicatedPayload,
  coerceTaskStallAdjudicatedPayload,
  coerceTaskStuckDetectedPayload,
  toTaskWatchdogEventPayload,
  type BrewvaEventRecord,
  type BrewvaRuntime,
  type TapePressureLevel,
  type TaskStallAdjudicatedPayload,
  type TaskStallAdjudicationDecision,
  type TaskStuckDetectedPayload,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";

const TASK_STALL_INSPECTION_SCHEMA = "brewva.task-stall-inspection.v1" as const;
const RECENT_FAILURE_LIMIT = 6;
const RECENT_BLOCKED_TOOL_LIMIT = 4;

interface TaskStallVerificationSummary {
  passed: boolean;
  skipped: boolean;
  level: string;
  missingChecks: string[];
  missingEvidence: string[];
  lastOutcome: "pass" | "fail" | "skipped" | null;
  lastOutcomeAt: number | null;
  failedChecks: string[];
  evidenceFreshness: string | null;
}

export interface TaskStallRecentFailure {
  toolName: string;
  verdict: "pass" | "fail" | "inconclusive";
  failureClass: string | null;
  timestamp: number;
}

export interface TaskStallInspectionPacket {
  schema: typeof TASK_STALL_INSPECTION_SCHEMA;
  sessionId: string;
  detectedAt: number;
  baselineProgressAt: number;
  thresholdMs: number;
  idleMs: number;
  openItemCount: number;
  task: {
    goal: string | null;
    phase: string | null;
    acceptance: "pending" | "accepted" | "rejected" | null;
    blockerCount: number;
    blockers: string[];
    itemCount: number;
  };
  verification: TaskStallVerificationSummary;
  tape: {
    pressure: TapePressureLevel;
    totalEntries: number;
    entriesSinceAnchor: number;
    entriesSinceCheckpoint: number;
  };
  signals: {
    recentToolFailures: TaskStallRecentFailure[];
    blockedToolCount: number;
    pendingWorkerResults: number;
  };
}

export interface TaskStallAdjudication {
  decision: TaskStallAdjudicationDecision;
  rationale: string;
  signalSummary: string[];
  source?: "heuristic" | "hook";
}

export type TaskStallAdjudicator = (packet: TaskStallInspectionPacket) => TaskStallAdjudication;

export interface MaybeAdjudicateTaskStallInput {
  runtime: BrewvaRuntime;
  sessionId: string;
  adjudicator?: TaskStallAdjudicator;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function lastEvent(events: BrewvaEventRecord[]): BrewvaEventRecord | undefined {
  return events[events.length - 1];
}

function readVerificationSummary(
  runtime: BrewvaRuntime,
  sessionId: string,
): TaskStallVerificationSummary {
  const lastOutcomeEvent = lastEvent(
    runtime.inspect.events.query(sessionId, {
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      last: 1,
    }),
  );
  const payload = isRecord(lastOutcomeEvent?.payload) ? lastOutcomeEvent.payload : undefined;
  const lastOutcome: TaskStallVerificationSummary["lastOutcome"] =
    payload?.outcome === "pass" || payload?.outcome === "fail" || payload?.outcome === "skipped"
      ? payload.outcome
      : null;
  const evidenceFreshness =
    typeof payload?.evidenceFreshness === "string" ? payload.evidenceFreshness : null;
  return {
    passed: lastOutcome === "pass",
    skipped: lastOutcome === null || lastOutcome === "skipped",
    level: typeof payload?.level === "string" ? payload.level : "unknown",
    missingChecks: readStringArray(payload?.missingChecks),
    missingEvidence: readStringArray(payload?.missingEvidence),
    lastOutcome,
    lastOutcomeAt: lastOutcomeEvent?.timestamp ?? null,
    failedChecks: readStringArray(payload?.failedChecks),
    evidenceFreshness,
  };
}

function readRecentToolFailures(
  runtime: BrewvaRuntime,
  sessionId: string,
): TaskStallRecentFailure[] {
  return runtime.inspect.events
    .query(sessionId, {
      type: TOOL_RESULT_RECORDED_EVENT_TYPE,
      last: RECENT_FAILURE_LIMIT,
    })
    .flatMap((event) => {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const toolName = typeof payload?.toolName === "string" ? payload.toolName : null;
      const verdict =
        payload?.verdict === "pass" ||
        payload?.verdict === "fail" ||
        payload?.verdict === "inconclusive"
          ? payload.verdict
          : null;
      if (!toolName || !verdict || (verdict !== "fail" && verdict !== "inconclusive")) {
        return [];
      }
      return [
        {
          toolName,
          verdict,
          failureClass: typeof payload?.failureClass === "string" ? payload.failureClass : null,
          timestamp: event.timestamp,
        },
      ];
    });
}

function readBlockedToolCount(runtime: BrewvaRuntime, sessionId: string): number {
  return runtime.inspect.events.query(sessionId, {
    type: TOOL_CALL_BLOCKED_EVENT_TYPE,
    last: RECENT_BLOCKED_TOOL_LIMIT,
  }).length;
}

function summarizeSignals(packet: TaskStallInspectionPacket): string[] {
  const signals: string[] = [];
  if (packet.task.acceptance === "rejected") {
    signals.push("task_acceptance_rejected");
  }
  if (packet.tape.pressure === "high") {
    signals.push("tape_pressure_high");
  } else if (packet.tape.pressure === "medium") {
    signals.push("tape_pressure_medium");
  }
  if (packet.task.blockerCount > 0) {
    signals.push(`blockers=${packet.task.blockerCount}`);
  }
  if (packet.signals.blockedToolCount > 0) {
    signals.push(`blocked_tool_calls=${packet.signals.blockedToolCount}`);
  }
  if (packet.signals.recentToolFailures.length > 0) {
    signals.push(`recent_tool_failures=${packet.signals.recentToolFailures.length}`);
  }
  if (packet.signals.pendingWorkerResults > 0) {
    signals.push(`pending_worker_results=${packet.signals.pendingWorkerResults}`);
  }
  if (!packet.verification.passed && !packet.verification.skipped) {
    if (packet.verification.failedChecks.length > 0) {
      signals.push(`verification_failed=${packet.verification.failedChecks.join(",")}`);
    } else if (packet.verification.missingChecks.length > 0) {
      signals.push(`verification_missing=${packet.verification.missingChecks.join(",")}`);
    } else {
      signals.push("verification_state_inconsistent");
    }
  }
  return signals.length > 0 ? signals : ["no_strong_secondary_signals"];
}

export function buildTaskStallInspectionPacket(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  detected: TaskStuckDetectedPayload;
}): TaskStallInspectionPacket {
  const taskState = input.runtime.inspect.task.getState(input.sessionId);
  const verification = readVerificationSummary(input.runtime, input.sessionId);
  const tape = input.runtime.inspect.events.getTapeStatus(input.sessionId);
  const pendingWorkerResults = input.runtime.inspect.session.listWorkerResults(
    input.sessionId,
  ).length;
  return {
    schema: TASK_STALL_INSPECTION_SCHEMA,
    sessionId: input.sessionId,
    detectedAt: input.detected.detectedAt,
    baselineProgressAt: input.detected.baselineProgressAt,
    thresholdMs: input.detected.thresholdMs,
    idleMs: input.detected.idleMs,
    openItemCount: input.detected.openItemCount,
    task: {
      goal: taskState.spec?.goal ?? null,
      phase: taskState.status?.phase ?? null,
      acceptance: taskState.acceptance?.status ?? null,
      blockerCount: taskState.blockers.length,
      blockers: taskState.blockers.map((blocker) => blocker.message),
      itemCount: taskState.items.length,
    },
    verification,
    tape: {
      pressure: tape.tapePressure,
      totalEntries: tape.totalEntries,
      entriesSinceAnchor: tape.entriesSinceAnchor,
      entriesSinceCheckpoint: tape.entriesSinceCheckpoint,
    },
    signals: {
      recentToolFailures: readRecentToolFailures(input.runtime, input.sessionId),
      blockedToolCount: readBlockedToolCount(input.runtime, input.sessionId),
      pendingWorkerResults,
    },
  };
}

export function adjudicateTaskStallPacket(
  packet: TaskStallInspectionPacket,
): TaskStallAdjudication {
  const signalSummary = summarizeSignals(packet);

  if (packet.task.acceptance === "rejected") {
    return {
      decision: "abort_recommended",
      rationale:
        "Task acceptance is already rejected, so continuing the stalled turn would push against an explicit stop signal.",
      signalSummary,
      source: "heuristic",
    };
  }

  if (packet.tape.pressure === "high") {
    return {
      decision: "compact_recommended",
      rationale:
        "The session is stalled under high tape pressure; compact before asking the model to continue.",
      signalSummary,
      source: "heuristic",
    };
  }

  if (packet.signals.recentToolFailures.length >= 3 && packet.tape.pressure !== "none") {
    return {
      decision: "compact_recommended",
      rationale:
        "Repeated failed tool attempts plus tape pressure suggest context cleanup before another repair attempt.",
      signalSummary,
      source: "heuristic",
    };
  }

  if (
    packet.task.blockerCount > 0 ||
    packet.signals.blockedToolCount > 0 ||
    packet.verification.lastOutcome === "fail" ||
    packet.signals.pendingWorkerResults > 0 ||
    packet.signals.recentToolFailures.length > 0
  ) {
    return {
      decision: "nudge",
      rationale:
        "The stall has concrete secondary signals and should surface a directed next step instead of silently waiting.",
      signalSummary,
      source: "heuristic",
    };
  }

  return {
    decision: "continue",
    rationale:
      "Only idle time crossed the threshold; no stronger blocker, failure, or pressure signal was found.",
    signalSummary,
    source: "heuristic",
  };
}

function hasAdjudicationForDetection(
  runtime: BrewvaRuntime,
  sessionId: string,
  detectedAt: number,
): boolean {
  return runtime.inspect.events
    .query(sessionId, {
      type: TASK_STALL_ADJUDICATED_EVENT_TYPE,
      last: 6,
    })
    .some((event) => coerceTaskStallAdjudicatedPayload(event.payload)?.detectedAt === detectedAt);
}

function hasAdjudicationErrorForDetection(
  runtime: BrewvaRuntime,
  sessionId: string,
  detectedAt: number,
): boolean {
  return runtime.inspect.events
    .query(sessionId, {
      type: TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
      last: 6,
    })
    .some((event) => {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      return Number(payload?.detectedAt) === detectedAt;
    });
}

export function maybeAdjudicateLatestTaskStall(
  input: MaybeAdjudicateTaskStallInput,
): TaskStallAdjudicatedPayload | null {
  const latestDetected = lastEvent(
    input.runtime.inspect.events.query(input.sessionId, {
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      last: 1,
    }),
  );
  const detected = coerceTaskStuckDetectedPayload(latestDetected?.payload);
  if (!latestDetected || !detected) {
    return null;
  }
  if (
    hasAdjudicationForDetection(input.runtime, input.sessionId, detected.detectedAt) ||
    hasAdjudicationErrorForDetection(input.runtime, input.sessionId, detected.detectedAt)
  ) {
    return null;
  }

  const packet = buildTaskStallInspectionPacket({
    runtime: input.runtime,
    sessionId: input.sessionId,
    detected,
  });

  try {
    const adjudication = input.adjudicator?.(packet) ?? adjudicateTaskStallPacket(packet);
    const adjudicatedAt = input.now?.() ?? Date.now();
    const payload = buildTaskStallAdjudicatedPayload({
      detectedAt: detected.detectedAt,
      baselineProgressAt: detected.baselineProgressAt,
      adjudicatedAt,
      decision: adjudication.decision,
      source: adjudication.source ?? (input.adjudicator ? "hook" : "heuristic"),
      rationale: adjudication.rationale,
      signalSummary:
        adjudication.signalSummary.length > 0 ? adjudication.signalSummary : ["no_signal_summary"],
      tapePressure: packet.tape.pressure,
      blockerCount: packet.task.blockerCount,
      blockedToolCount: packet.signals.blockedToolCount,
      failureCount: packet.signals.recentToolFailures.length,
      pendingWorkerResults: packet.signals.pendingWorkerResults,
      verificationLastOutcome: packet.verification.lastOutcome,
      verificationPassed: packet.verification.passed,
      verificationSkipped: packet.verification.skipped,
    });
    recordRuntimeEvent(input.runtime, {
      sessionId: input.sessionId,
      type: TASK_STALL_ADJUDICATED_EVENT_TYPE,
      turn: latestDetected.turn,
      timestamp: adjudicatedAt,
      payload: toTaskWatchdogEventPayload(payload),
    });
    return payload;
  } catch (error) {
    recordRuntimeEvent(input.runtime, {
      sessionId: input.sessionId,
      type: TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
      turn: latestDetected.turn,
      payload: {
        detectedAt: detected.detectedAt,
        baselineProgressAt: detected.baselineProgressAt,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
}
