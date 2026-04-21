import type { RecoveryWalStore } from "../channels/recovery-wal.js";
import type {
  BrewvaEventRecord,
  IntegrityIssue,
  IntegrityStatus,
  OpenTurnRecord,
  SessionUncleanShutdownDiagnostic,
  SessionUncleanShutdownReason,
} from "../contracts/index.js";
import {
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
  TURN_END_EVENT_TYPE,
  TURN_START_EVENT_TYPE,
} from "../events/event-types.js";
import type { BrewvaEventStore } from "../events/store.js";
import { deriveRecoveryCanonicalization } from "../recovery/read-model.js";
import { RuntimeSessionStateCell, RuntimeSessionStateStore } from "./session-state.js";

const UNCLEAN_SHUTDOWN_RECONCILIATION_GRACE_MS = 5_000;

export interface SessionIntegrityCoordinatorOptions {
  sessionState: RuntimeSessionStateStore;
  eventStore: BrewvaEventStore;
  recoveryWalStore: RecoveryWalStore;
  recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;
}

export class SessionIntegrityCoordinator {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly events: BrewvaEventStore;
  private readonly recoveryWal: RecoveryWalStore;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;

  constructor(options: SessionIntegrityCoordinatorOptions) {
    this.sessionState = options.sessionState;
    this.events = options.eventStore;
    this.recoveryWal = options.recoveryWalStore;
    this.recordEvent = (input) => options.recordEvent(input);
  }

  refreshHydrationState(sessionId: string): void {
    const state = this.sessionState.getExistingCell(sessionId);
    if (!state || state.hydration.status === "cold") {
      return;
    }
    const tapeIssues = this.events.getIntegrityIssues(sessionId);
    if (tapeIssues.length === 0) {
      return;
    }
    const seen = new Set(state.hydration.issues.map((issue) => this.integrityIssueKey(issue)));
    const nextIssues = state.hydration.issues.map((issue) => ({ ...issue }));
    let changed = false;
    for (const issue of tapeIssues) {
      const key = this.integrityIssueKey(issue);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      nextIssues.push({ ...issue });
      changed = true;
    }
    if (!changed) {
      return;
    }
    state.hydration = {
      ...state.hydration,
      status: "degraded",
      issues: nextIssues,
    };
  }

  getIntegrityStatus(sessionId: string): IntegrityStatus {
    this.refreshHydrationState(sessionId);
    const hydrationIssues = structuredClone(
      this.sessionState.getExistingCell(sessionId)?.hydration.issues ?? [],
    );
    const issues = [
      ...hydrationIssues,
      ...this.recoveryWal.getIntegrityIssues(),
      ...this.getArtifactIntegrityIssues(sessionId),
    ];
    return {
      status: this.resolveIntegrityStatus(issues),
      issues,
    };
  }

  reconcileHydratedSession(input: {
    sessionId: string;
    events: BrewvaEventRecord[];
    state: RuntimeSessionStateCell;
    initialIssues: IntegrityIssue[];
  }): void {
    this.reconcileUncleanShutdown(input.sessionId, input.events, input.state);
  }

  canonicalizeBeforeHydration(input: {
    sessionId: string;
    events: BrewvaEventRecord[];
    integrityIssues: IntegrityIssue[];
  }): void {
    this.applyRecoveryCanonicalization(input.sessionId, input.events, input.integrityIssues);
  }

  private applyRecoveryCanonicalization(
    sessionId: string,
    events: BrewvaEventRecord[],
    integrityIssues: IntegrityIssue[],
  ): void {
    const canonicalization = deriveRecoveryCanonicalization(events);
    if (events.length === 0 || canonicalization.mode !== "degraded") {
      return;
    }
    const latestEvent = events[events.length - 1];
    if (!latestEvent || latestEvent.type === SESSION_SHUTDOWN_EVENT_TYPE) {
      return;
    }
    if (Date.now() - latestEvent.timestamp < UNCLEAN_SHUTDOWN_RECONCILIATION_GRACE_MS) {
      return;
    }
    const issue: IntegrityIssue = {
      domain: "event_tape",
      severity: "degraded",
      sessionId,
      eventType: SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
      reason: canonicalization.degradedReason ?? "recovery_canonicalization_degraded",
    };
    const issueKey = this.integrityIssueKey(issue);
    if (integrityIssues.some((entry) => this.integrityIssueKey(entry) === issueKey)) {
      return;
    }
    integrityIssues.push(issue);
  }

  private getArtifactIntegrityIssues(sessionId: string): IntegrityIssue[] {
    return this.events
      .list(sessionId, { type: TOOL_OUTPUT_ARTIFACT_PERSIST_FAILED_EVENT_TYPE })
      .map((event, index) => ({
        domain: "artifact" as const,
        severity: "degraded" as const,
        sessionId,
        eventId: event.id,
        eventType: event.type,
        index,
        reason:
          typeof event.payload?.reason === "string" && event.payload.reason.trim().length > 0
            ? event.payload.reason
            : "artifact_persist_failed",
      }));
  }

  private resolveIntegrityStatus(issues: readonly IntegrityIssue[]): IntegrityStatus["status"] {
    if (issues.some((issue) => issue.severity === "unavailable")) {
      return "unavailable";
    }
    return issues.length > 0 ? "degraded" : "healthy";
  }

  private reconcileUncleanShutdown(
    sessionId: string,
    events: BrewvaEventRecord[],
    state: RuntimeSessionStateCell,
  ): void {
    if (events.length === 0) {
      return;
    }

    const latestEvent = events[events.length - 1];
    if (!latestEvent || latestEvent.type === SESSION_SHUTDOWN_EVENT_TYPE) {
      return;
    }
    if (Date.now() - latestEvent.timestamp < UNCLEAN_SHUTDOWN_RECONCILIATION_GRACE_MS) {
      return;
    }
    if (
      events.some((event) => event.type === SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE) ||
      state.uncleanShutdownDiagnostic
    ) {
      return;
    }

    const openToolCalls = [...state.openToolCalls.values()]
      .map((record) => Object.assign({}, record))
      .toSorted(
        (left, right) =>
          left.openedAt - right.openedAt || left.toolCallId.localeCompare(right.toolCallId),
      );
    const openTurns = this.collectOpenTurns(events);
    const reasons: SessionUncleanShutdownReason[] = [];
    if (openToolCalls.length > 0) {
      reasons.push("open_tool_calls_without_terminal_receipt");
    }
    if (openTurns.length > 0) {
      reasons.push("open_turn_without_terminal_receipt");
    }
    if (state.activeSkillState) {
      reasons.push("active_skill_without_terminal_receipt");
    }
    if (reasons.length === 0) {
      return;
    }

    const diagnostic: SessionUncleanShutdownDiagnostic = {
      detectedAt: Date.now(),
      reasons,
      openToolCalls,
      ...(openTurns.length > 0 ? { openTurns } : {}),
      ...(state.activeSkillState ? { activeSkill: structuredClone(state.activeSkillState) } : {}),
      ...(state.latestSkillFailure
        ? { latestFailure: structuredClone(state.latestSkillFailure) }
        : {}),
      latestEventType: latestEvent.type,
      latestEventAt: latestEvent.timestamp,
    };
    state.uncleanShutdownDiagnostic = diagnostic;

    this.appendHydrationIssue(state, {
      domain: "event_tape",
      severity: "degraded",
      sessionId,
      eventType: SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
      reason: `${reasons.join("+")}:${[
        openToolCalls.length > 0
          ? `tools=${openToolCalls.map((record) => record.toolName).join(",")}`
          : null,
        openTurns.length > 0 ? `turns=${openTurns.map((record) => record.turn).join(",")}` : null,
        state.activeSkillState ? `skill=${state.activeSkillState.skillName}` : null,
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join(";")}`,
    });

    this.recordEvent({
      sessionId,
      type: SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
      payload: diagnostic,
      skipTapeCheckpoint: true,
    });
  }

  private collectOpenTurns(events: BrewvaEventRecord[]): OpenTurnRecord[] {
    const openTurns = new Map<number, OpenTurnRecord>();
    for (const event of events) {
      if (typeof event.turn !== "number" || !Number.isFinite(event.turn)) {
        continue;
      }
      const turn = Math.max(0, Math.floor(event.turn));
      if (event.type === TURN_START_EVENT_TYPE) {
        openTurns.set(turn, {
          turn,
          startedAt: event.timestamp,
          eventId: event.id,
        });
        continue;
      }
      if (event.type === TURN_END_EVENT_TYPE) {
        openTurns.delete(turn);
      }
    }
    return [...openTurns.values()].toSorted((left, right) => left.turn - right.turn);
  }

  private appendHydrationIssue(state: RuntimeSessionStateCell, issue: IntegrityIssue): void {
    const key = this.integrityIssueKey(issue);
    const existingKeys = new Set(
      state.hydration.issues.map((entry) => this.integrityIssueKey(entry)),
    );
    if (existingKeys.has(key)) {
      return;
    }
    state.hydration = {
      ...state.hydration,
      status: "degraded",
      issues: [...state.hydration.issues, issue],
    };
  }

  private integrityIssueKey(issue: IntegrityIssue): string {
    return [
      issue.domain,
      issue.severity,
      issue.sessionId ?? "",
      issue.eventId ?? "",
      issue.eventType ?? "",
      issue.index ?? -1,
      issue.reason,
    ].join(":");
  }
}
