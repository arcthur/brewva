import { asBrewvaSessionId } from "@brewva/brewva-runtime";
import { formatInspectAnalysisText } from "../inspect-analysis.js";
import { buildSessionInspectReport } from "../inspect.js";
import {
  countQuestionRequestKinds,
  describeQuestionRequestSummary,
  questionRequestsFromOverlay,
  resolveQuestionOverlayTitle,
} from "./question-utils.js";
import { buildTaskRunListLabel, buildTaskRunPreviewLines } from "./task-details.js";
import type {
  CliNotificationsOverlayPayload,
  CliOverlayNotification,
  CliOverlaySection,
  CliSessionsOverlayPayload,
  CliShellOverlayPayload,
  OperatorSurfaceSnapshot,
} from "./types.js";

type SessionInspectReport = ReturnType<typeof buildSessionInspectReport>;

interface PickerInspectLineItem {
  section?: string;
  label: string;
  detail?: string;
}

function renderPickerInspectLines(
  items: readonly PickerInspectLineItem[],
  selectedIndex: number,
): string[] {
  return items.map((item, index) => {
    const marker = index === selectedIndex ? ">" : " ";
    const section = item.section ? `${item.section}: ` : "";
    const detail = item.detail ? ` :: ${item.detail}` : "";
    return `${marker} ${section}${item.label}${detail}`;
  });
}

export function resolveOverlayFocusOwner(
  payload: CliShellOverlayPayload,
):
  | "approvalOverlay"
  | "questionOverlay"
  | "taskBrowser"
  | "sessionSwitcher"
  | "notificationCenter"
  | "inspectOverlay"
  | "pager"
  | "dialog" {
  switch (payload.kind) {
    case "approval":
      return "approvalOverlay";
    case "question":
      return "questionOverlay";
    case "tasks":
      return "taskBrowser";
    case "sessions":
      return "sessionSwitcher";
    case "notifications":
      return "notificationCenter";
    case "inspect":
      return "inspectOverlay";
    case "pager":
      return "pager";
    case "confirm":
    case "input":
    case "select":
    case "modelPicker":
    case "providerPicker":
    case "thinkingPicker":
    case "authMethodPicker":
    case "oauthWait":
    case "commandPalette":
    case "helpHub":
      return "dialog";
    default: {
      const exhaustiveCheck: never = payload;
      return exhaustiveCheck;
    }
  }
}

export function buildInspectSections(report: SessionInspectReport): CliOverlaySection[] {
  const base = report.base;
  const sections: CliOverlaySection[] = [
    {
      id: "summary",
      title: "Summary",
      lines: [
        `Session: ${base.sessionId}`,
        `Workspace: ${base.workspaceRoot}`,
        `Config mode: ${base.configLoad.mode}`,
        `Config paths: ${renderListValue(base.configLoad.paths)}`,
        `Managed tool mode: ${base.bootstrap.managedToolMode ?? "n/a"}`,
      ],
    },
    {
      id: "runtime",
      title: "Runtime",
      lines: [
        `Hydration: ${base.hydration.status} (issues=${base.hydration.issueCount})`,
        `Integrity: ${base.integrity.status} (issues=${base.integrity.issueCount})`,
        `Replay: events=${base.replay.eventCount} anchors=${base.replay.anchorCount} checkpoints=${base.replay.checkpointCount}`,
        `Tape pressure: ${base.replay.tapePressure}`,
        `Entries since anchor: ${base.replay.entriesSinceAnchor}`,
      ],
    },
    {
      id: "task",
      title: "Task + Truth",
      lines: [
        `Goal: ${base.task.goal ?? "n/a"}`,
        `Task phase: ${base.task.phase ?? "n/a"}`,
        `Task health: ${base.task.health ?? "n/a"}`,
        `Task items: ${base.task.items}`,
        `Task blockers: ${base.task.blockers}`,
        `Truth: ${base.truth.activeFacts}/${base.truth.totalFacts} active`,
      ],
    },
    {
      id: "skills",
      title: "Skills + Verification",
      lines: [
        `Active skill: ${base.skills.activeSkill ?? "none"}`,
        `Completed skills: ${renderListValue(base.skills.completedSkills)}`,
        `Verification outcome: ${base.verification.outcome ?? "n/a"}`,
        `Verification level: ${base.verification.level ?? "n/a"}`,
        `Failed checks: ${renderListValue(base.verification.failedChecks)}`,
        `Missing checks: ${renderListValue(base.verification.missingChecks)}`,
        `Missing evidence: ${renderListValue(base.verification.missingEvidence)}`,
        `Verification reason: ${base.verification.reason ?? "n/a"}`,
      ],
    },
    {
      id: "artifacts",
      title: "Artifacts",
      lines: [
        `Ledger: rows=${base.ledger.rows} integrity=${base.ledger.integrityValid ? "valid" : "invalid"}`,
        `Ledger path: ${base.ledger.path}`,
        `Projection: enabled=${base.projection.enabled ? "yes" : "no"} working=${base.projection.workingExists ? "present" : "missing"}`,
        `Projection path: ${base.projection.workingPath}`,
        `Recovery WAL: enabled=${base.recoveryWal.enabled ? "yes" : "no"} pending=${base.recoveryWal.pendingCount} sessionPending=${base.recoveryWal.pendingSessionCount}`,
        `Recovery WAL path: ${base.recoveryWal.filePath}`,
        `Snapshots: sessionDir=${base.snapshots.sessionDirExists ? "present" : "missing"} patchHistory=${base.snapshots.patchHistoryExists ? "present" : "missing"}`,
        `Patch history path: ${base.snapshots.patchHistoryPath}`,
        `Consistency: ledger=${base.consistency.ledgerIntegrity} pendingRecoveryWal=${base.consistency.pendingRecoveryWal}`,
      ],
    },
    {
      id: "routing",
      title: "Bootstrap + Routing",
      lines: [
        `Routing enabled: ${renderNullableBoolean(base.bootstrap.routingEnabled)}`,
        `Routing scopes: ${renderListValue(base.bootstrap.routingScopes)}`,
        `Routable skills: ${renderListValue(base.bootstrap.routableSkills)}`,
        `Hidden skills: ${renderListValue(base.bootstrap.hiddenSkills)}`,
        `Config path: ${base.bootstrap.configPath ?? "n/a"}`,
        `Events dir: ${base.bootstrap.eventsDir ?? "n/a"}`,
        `Recovery WAL dir: ${base.bootstrap.recoveryWalDir ?? "n/a"}`,
        `Projection dir: ${base.bootstrap.projectionDir ?? "n/a"}`,
      ],
    },
    {
      id: "hosted",
      title: "Hosted",
      lines: [
        `Transition sequence: ${base.hostedTransitions.sequence}`,
        `Latest: ${
          base.hostedTransitions.latest
            ? `${base.hostedTransitions.latest.reason}:${base.hostedTransitions.latest.status}`
            : "none"
        }`,
        `Pending family: ${base.hostedTransitions.pendingFamily ?? "none"}`,
        `Operator-visible generation: ${base.hostedTransitions.operatorVisibleFactGeneration}`,
        `Compaction breaker: ${base.hostedTransitions.breakerOpenByReason.compaction_retry ? "open" : "closed"} (${base.hostedTransitions.consecutiveFailuresByReason.compaction_retry ?? 0})`,
        `Provider fallback breaker: ${base.hostedTransitions.breakerOpenByReason.provider_fallback_retry ? "open" : "closed"} (${base.hostedTransitions.consecutiveFailuresByReason.provider_fallback_retry ?? 0})`,
        `Max-output breaker: ${base.hostedTransitions.breakerOpenByReason.max_output_recovery ? "open" : "closed"} (${base.hostedTransitions.consecutiveFailuresByReason.max_output_recovery ?? 0})`,
      ],
    },
  ];

  if (base.hydration.issues.length > 0 || base.integrity.issues.length > 0) {
    sections.push({
      id: "issues",
      title: "Issues",
      lines: [
        ...base.hydration.issues.map(
          (issue) =>
            `Hydration issue #${issue.index}: ${issue.eventType} :: ${issue.reason} (${issue.eventId})`,
        ),
        ...base.integrity.issues.map(
          (issue) =>
            `Integrity issue: ${issue.domain}/${issue.severity} :: ${issue.reason} (${issue.eventId ?? "n/a"})`,
        ),
      ],
    });
  }

  if (base.configLoad.warnings.length > 0) {
    sections.push({
      id: "config",
      title: "Config Warnings",
      lines: base.configLoad.warnings.map(
        (warning) =>
          `${warning.code}: ${warning.message} :: ${warning.configPath} :: ${renderListValue(
            warning.fields,
          )}`,
      ),
    });
  }

  if (base.recoveryWal.pendingRows.length > 0) {
    sections.push({
      id: "recovery",
      title: "Recovery WAL",
      lines: base.recoveryWal.pendingRows.map(
        (row) =>
          `${row.source}/${row.status} turn=${row.turnId} channel=${row.channel} tool=${row.toolName ?? "n/a"} updated=${row.updatedAt ?? "n/a"}`,
      ),
    });
  }

  sections.push({
    id: "analysis",
    title: "Analysis",
    lines: formatInspectAnalysisText(report).split("\n"),
  });

  return sections;
}

export function buildOverlayView(payload: CliShellOverlayPayload): {
  title: string;
  lines: string[];
} {
  switch (payload.kind) {
    case "approval": {
      const lines = [
        `Pending approvals: ${payload.snapshot.approvals.length}`,
        "Use ↑/↓ to choose, Enter or a to accept, r to reject, Ctrl+F to expand diff, Esc to close.",
      ];
      for (const [index, item] of payload.snapshot.approvals.entries()) {
        const marker = index === payload.selectedIndex ? ">" : " ";
        lines.push(
          `${marker} [${item.requestId}] ${item.toolName} :: ${item.subject} :: ${item.effects.join(", ")}`,
        );
      }
      if (payload.snapshot.approvals.length === 0) {
        lines.push("No pending approvals.");
      }
      return { title: "Approvals", lines };
    }
    case "question": {
      const requests = questionRequestsFromOverlay(payload);
      const { inputRequestCount, followUpCount } = countQuestionRequestKinds(requests);
      const lines = [
        `${payload.mode === "interactive" ? "Pending input requests" : "Operator inbox"}: ${requests.length}`,
        `Input requests: ${inputRequestCount} · Follow-up questions: ${followUpCount}`,
        "Use ←/→ or Tab to switch tabs, ↑/↓ to choose options, Enter to submit, Esc to dismiss.",
      ];
      for (const [index, item] of requests.entries()) {
        const marker = index === payload.selectedIndex ? ">" : " ";
        lines.push(
          `${marker} [${item.requestId}] ${item.sourceLabel} :: ${describeQuestionRequestSummary(item)}`,
        );
      }
      if (requests.length === 0) {
        lines.push("No pending operator input.");
      }
      return { title: resolveQuestionOverlayTitle(payload), lines };
    }
    case "tasks": {
      const lines = [
        `Task runs: ${payload.snapshot.taskRuns.length}`,
        "Use ↑/↓ to choose, c to cancel the selected run, Esc to close.",
      ];
      for (const [index, item] of payload.snapshot.taskRuns.entries()) {
        const marker = index === payload.selectedIndex ? ">" : " ";
        lines.push(`${marker} ${buildTaskRunListLabel(item)}`);
      }
      if (payload.snapshot.taskRuns.length === 0) {
        lines.push("No recorded task runs.");
      } else {
        const selected = payload.snapshot.taskRuns[payload.selectedIndex];
        if (selected) {
          lines.push("", ...buildTaskRunPreviewLines(selected));
        }
      }
      return { title: "Tasks", lines };
    }
    case "sessions": {
      const lines = [
        `Sessions: ${payload.sessions.length}`,
        "Use ↑/↓ to choose, Enter to switch, n to create a new session, Esc to close.",
      ];
      for (const [index, item] of payload.sessions.entries()) {
        const marker = index === payload.selectedIndex ? ">" : " ";
        const current = item.sessionId === payload.currentSessionId ? " current" : "";
        const draft = payload.draftStateBySessionId[item.sessionId];
        const draftText = draft ? ` draft=${draft.lines}l/${draft.characters}c` : "";
        lines.push(`${marker} [${item.sessionId}] events=${item.eventCount}${current}${draftText}`);
      }
      if (payload.sessions.length === 0) {
        lines.push("No sessions found.");
      }
      return { title: "Sessions", lines };
    }
    case "notifications": {
      const lines = [
        `Notifications: ${payload.notifications.length}`,
        "Use ↑/↓ to choose, Enter to inspect, d to dismiss, x to clear all, Esc to close.",
      ];
      for (const [index, item] of payload.notifications.entries()) {
        const marker = index === payload.selectedIndex ? ">" : " ";
        lines.push(`${marker} ${renderNotificationSummary(item)}`);
      }
      if (payload.notifications.length === 0) {
        lines.push("No notifications.");
      }
      return { title: "Notifications", lines };
    }
    case "inspect":
      return {
        title: "Inspect",
        lines: payload.sections.map(
          (section, index) => `${index === payload.selectedIndex ? ">" : " "} ${section.title}`,
        ),
      };
    case "pager":
      return { title: payload.title ?? "Pager", lines: payload.lines };
    case "confirm":
      return { title: "Confirm", lines: [payload.message, "", "Enter=yes  Esc=no"] };
    case "input":
      return {
        title: "Input",
        lines: [
          payload.message ?? "",
          "",
          payload.masked ? "*".repeat(payload.value.length) : payload.value,
          "",
          "Enter=confirm  Esc=cancel",
        ],
      };
    case "select":
      return {
        title: "Select",
        lines: payload.options.map(
          (item, index) => `${index === payload.selectedIndex ? ">" : " "} ${item}`,
        ),
      };
    case "modelPicker":
      return {
        title: payload.title,
        lines: renderPickerInspectLines(payload.items, payload.selectedIndex),
      };
    case "providerPicker":
      return {
        title: payload.title,
        lines: renderPickerInspectLines(payload.items, payload.selectedIndex),
      };
    case "thinkingPicker":
      return {
        title: payload.title,
        lines: renderPickerInspectLines(payload.items, payload.selectedIndex),
      };
    case "authMethodPicker":
      return {
        title: payload.title,
        lines: renderPickerInspectLines(payload.items, payload.selectedIndex),
      };
    case "commandPalette":
      return {
        title: payload.title,
        lines: [
          `Search: ${payload.query}`,
          "Use ↑/↓ to choose, type to filter, Enter to run, Esc to close.",
          "",
          ...(payload.items.length > 0
            ? renderPickerInspectLines(payload.items, payload.selectedIndex)
            : ["No matching commands."]),
        ],
      };
    case "helpHub":
      return {
        title: payload.title,
        lines: payload.lines,
      };
    case "oauthWait":
      return {
        title: payload.title,
        lines: [
          payload.url,
          "",
          payload.instructions,
          "",
          "Waiting for authorization...",
          payload.manualCodePrompt ? "Enter/p=paste callback  c=copy" : "c=copy",
        ],
      };
    default: {
      const exhaustiveCheck: never = payload;
      return exhaustiveCheck;
    }
  }
}

export function buildNotificationsOverlayPayload(
  notificationsSource: readonly CliOverlayNotification[],
  selection: {
    id?: string;
    index?: number;
  } = {},
): CliNotificationsOverlayPayload {
  const notifications = [...notificationsSource].toReversed();
  const selectedIndexById =
    typeof selection.id === "string"
      ? notifications.findIndex((notification) => notification.id === selection.id)
      : -1;
  return {
    kind: "notifications",
    notifications,
    selectedIndex:
      selectedIndexById >= 0
        ? selectedIndexById
        : Math.max(0, Math.min(selection.index ?? 0, Math.max(0, notifications.length - 1))),
  };
}

export function buildSessionsOverlayPayload(input: {
  snapshot: OperatorSurfaceSnapshot;
  currentSessionId: string;
  draftsBySessionId: ReadonlyMap<string, { text: string }>;
  currentComposerText: string;
  selection?: {
    sessionId?: string;
    index?: number;
  };
}): CliSessionsOverlayPayload {
  const currentSession = input.snapshot.sessions.find(
    (session) => session.sessionId === input.currentSessionId,
  ) ?? {
    sessionId: asBrewvaSessionId(input.currentSessionId),
    eventCount: 0,
    lastEventAt: 0,
  };
  const sessions = [
    currentSession,
    ...input.snapshot.sessions.filter((session) => session.sessionId !== input.currentSessionId),
  ];
  const selectedIndexById =
    typeof input.selection?.sessionId === "string"
      ? sessions.findIndex((session) => session.sessionId === input.selection?.sessionId)
      : -1;
  const fallbackCurrentIndex = sessions.findIndex(
    (session) => session.sessionId === input.currentSessionId,
  );
  const draftStateBySessionId = Object.fromEntries(
    [...input.draftsBySessionId.entries()].map(([sessionId, draft]) => [
      sessionId,
      summarizeDraftPreview(draft.text),
    ]),
  ) as CliSessionsOverlayPayload["draftStateBySessionId"];

  if (input.currentComposerText.trim().length > 0) {
    draftStateBySessionId[input.currentSessionId] = summarizeDraftPreview(
      input.currentComposerText,
    );
  } else {
    delete draftStateBySessionId[input.currentSessionId];
  }

  return {
    kind: "sessions",
    sessions,
    currentSessionId: input.currentSessionId,
    draftStateBySessionId,
    selectedIndex:
      selectedIndexById >= 0
        ? selectedIndexById
        : fallbackCurrentIndex >= 0
          ? fallbackCurrentIndex
          : Math.max(0, Math.min(input.selection?.index ?? 0, Math.max(0, sessions.length - 1))),
  };
}

export function summarizeDraftPreview(text: string): {
  characters: number;
  lines: number;
  preview: string;
} {
  const trimmed = text.trim();
  return {
    characters: text.length,
    lines: Math.max(1, text.split(/\r?\n/u).length),
    preview: trimmed.split(/\r?\n/u)[0]?.slice(0, 96) ?? "",
  };
}

function renderListValue(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function renderNullableBoolean(value: boolean | null): string {
  if (value === null) {
    return "n/a";
  }
  return value ? "yes" : "no";
}

function renderNotificationSummary(notification: {
  level: "info" | "warning" | "error";
  message: string;
}): string {
  return `[${notification.level}] ${notification.message}`;
}
