import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { BrewvaReplaySession } from "@brewva/brewva-runtime/events";
import type { ForkPoint, SessionLineageTree } from "@brewva/brewva-runtime/session";
import type { BrewvaQueuedPromptView } from "@brewva/brewva-substrate/session";
import { truncateToWidth, visibleWidth } from "@brewva/brewva-tui";
import { formatInspectAnalysisText } from "../inspect-analysis.js";
import { buildSessionInspectReport } from "../inspect.js";
import {
  countQuestionRequestKinds,
  describeQuestionRequestSummary,
  questionRequestsFromOverlay,
  questionRequestsFromSnapshot,
  resolveQuestionOverlayTitle,
} from "./question-utils.js";
import { buildTaskRunListLabel, buildTaskRunPreviewLines } from "./task-details.js";
import type {
  CliNotificationsOverlayPayload,
  CliQueueOverlayPayload,
  CliInboxOverlayPayload,
  CliInboxOverlayItem,
  CliLineageOverlayPayload,
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
  | "inboxOverlay"
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
    case "inbox":
      return "inboxOverlay";
    case "tasks":
      return "taskBrowser";
    case "sessions":
      return "sessionSwitcher";
    case "lineage":
      return "dialog";
    case "notifications":
      return "notificationCenter";
    case "queue":
      return "dialog";
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
  const activeRewindTargets = base.rewind.activeTargets
    .slice(0, 5)
    .map(
      (target) =>
        `Active target: turn=${target.turn} checkpoint=${target.checkpointId} patchSetsAfter=${target.patchSetCountAfter} prompt=${target.promptPreview || "n/a"}`,
    );
  const abandonedRewindTargets = base.rewind.abandonedTargets
    .slice(0, 5)
    .map(
      (target) =>
        `Abandoned target: turn=${target.turn} checkpoint=${target.checkpointId} patchSetsAfter=${target.patchSetCountAfter} rewoundBy=${target.rewoundBy} prompt=${target.promptPreview || "n/a"}`,
    );
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
      id: "rewind",
      title: "Rewind",
      lines: [
        `Checkpoints: ${base.rewind.checkpointCount}`,
        `Targets: total=${base.rewind.targetCount} active=${base.rewind.activeTargetCount} abandoned=${base.rewind.abandonedTargetCount}`,
        `Available: rewind=${base.rewind.rewindAvailable ? "yes" : "no"} redo=${base.rewind.redoAvailable ? "yes" : "no"} redoDepth=${base.rewind.redoDepth}`,
        `Latest checkpoint: ${base.rewind.latestCheckpointId ?? "n/a"} turn=${base.rewind.latestCheckpointTurn ?? "n/a"} status=${base.rewind.latestCheckpointStatus ?? "n/a"}`,
        `Latest rewind: ${
          base.rewind.latestRewind
            ? `${base.rewind.latestRewind.trigger}/${base.rewind.latestRewind.mode}/${base.rewind.latestRewind.summary} -> ${base.rewind.latestRewind.checkpointId}`
            : "none"
        }`,
        `Next redo checkpoint: ${base.rewind.nextRedoCheckpointId ?? "none"}`,
        ...activeRewindTargets,
        ...(base.rewind.activeTargets.length > activeRewindTargets.length
          ? [
              `Active target: +${base.rewind.activeTargets.length - activeRewindTargets.length} more`,
            ]
          : []),
        ...abandonedRewindTargets,
        ...(base.rewind.abandonedTargets.length > abandonedRewindTargets.length
          ? [
              `Abandoned target: +${base.rewind.abandonedTargets.length - abandonedRewindTargets.length} more`,
            ]
          : []),
      ],
    },
    {
      id: "lineage",
      title: "Lineage",
      lines: base.lineage.supported
        ? [
            `Root: ${base.lineage.rootNodeId ?? "n/a"}`,
            `Current: ${base.lineage.currentNodeId ?? "n/a"} kind=${base.lineage.currentKind ?? "n/a"}`,
            `Topology: nodes=${base.lineage.nodeCount} edges=${base.lineage.edgeCount}`,
            `Context records: summaries=${base.lineage.summaryCount} outcomes=${base.lineage.outcomeCount} adopted=${base.lineage.adoptedOutcomeCount}`,
            `Selected channels: ${renderLineageSelectionValue(base.lineage.selectedByChannel)}`,
          ]
        : [`Unsupported: ${base.lineage.unsupportedReason ?? "n/a"}`],
    },
    {
      id: "task",
      title: "Task + Claim",
      lines: [
        `Goal: ${base.task.goal ?? "n/a"}`,
        `Task phase: ${base.task.phase ?? "n/a"}`,
        `Task health: ${base.task.health ?? "n/a"}`,
        `Task items: ${base.task.items}`,
        `Task blockers: ${base.task.blockers}`,
        `Claim: ${base.claim.activeClaims}/${base.claim.totalClaims} active`,
      ],
    },
    {
      id: "verification",
      title: "Verification",
      lines: [
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
      id: "bootstrap",
      title: "Bootstrap",
      lines: [
        `Workspace root: ${base.bootstrap.workspaceRoot ?? "n/a"}`,
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
    case "inbox": {
      const questionCount = questionRequestsFromSnapshot(payload.snapshot).length;
      const lines = [
        `Inbox: ${payload.items.length}`,
        `Pending questions: ${questionCount} · Notifications: ${payload.notifications.length}`,
        "Use ↑/↓ to choose, Enter to inspect, d to dismiss the selected notification, x to clear notifications, Esc to close.",
      ];
      for (const [index, item] of payload.items.entries()) {
        const marker = index === payload.selectedIndex ? ">" : " ";
        lines.push(`${marker} ${renderInboxItemSummary(item)}`);
      }
      if (payload.items.length === 0) {
        lines.push("No pending inbox items.");
      }
      return { title: "Inbox", lines };
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
    case "lineage": {
      const lines = [
        `Lineage: ${payload.nodes.length}`,
        `Current: ${payload.currentLineageNodeId ?? "none"} root=${payload.rootNodeId}`,
        "Use Up/Down to choose, Enter to checkout, Esc to close.",
      ];
      for (const [index, item] of payload.nodes.entries()) {
        const marker = index === payload.selectedIndex ? ">" : " ";
        const current = item.current ? " current" : "";
        const title = item.title ?? item.kind;
        const indent = "  ".repeat(item.depth);
        const leaf = item.leafEntryId ?? "root";
        lines.push(
          `${marker} ${indent}${title} [${item.lineageNodeId}] kind=${item.kind} leaf=${leaf}${current}`,
        );
      }
      if (payload.nodes.length === 0) {
        lines.push("No lineage nodes found.");
      }
      return { title: "Lineage", lines };
    }
    case "queue": {
      const lines = [
        `Queued prompts: ${payload.items.length}`,
        "Use ↑/↓ to choose, Enter to inspect, d to delete, Esc to close.",
      ];
      for (const [index, item] of payload.items.entries()) {
        const marker = index === payload.selectedIndex ? ">" : " ";
        lines.push(`${marker} [queued] ${renderQueuePromptSummary(item.text)}`);
      }
      if (payload.items.length === 0) {
        lines.push("No queued prompts.");
      }
      return { title: "Queued prompts", lines };
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

export function buildQueueOverlayPayload(input: {
  items: readonly BrewvaQueuedPromptView[];
  selection?: {
    promptId?: string;
    index?: number;
  };
}): CliQueueOverlayPayload {
  const selectedIndexById =
    typeof input.selection?.promptId === "string"
      ? input.items.findIndex((item) => item.promptId === input.selection?.promptId)
      : -1;
  return {
    kind: "queue",
    items: input.items,
    selectedIndex:
      selectedIndexById >= 0
        ? selectedIndexById
        : Math.max(0, Math.min(input.selection?.index ?? 0, Math.max(0, input.items.length - 1))),
  };
}

export function buildQueuePromptDetailLines(item: BrewvaQueuedPromptView): string[] {
  return [
    `promptId: ${item.promptId}`,
    `behavior: ${item.behavior}`,
    `submittedAt: ${new Date(item.submittedAt).toISOString()}`,
    "",
    ...item.text.split(/\r?\n/u),
  ];
}

export function buildLineageOverlayPayload(input: {
  tree: SessionLineageTree;
  currentLineageNodeId: string | null;
  leafEntryIdsByLineageNodeId?: ReadonlyMap<string, string | null>;
  selection?: {
    lineageNodeId?: string;
    index?: number;
  };
}): CliLineageOverlayPayload {
  const nodesById = new Map(input.tree.nodes.map((node) => [node.lineageNodeId, node] as const));
  const childrenByParent = new Map<string, string[]>();
  for (const edge of input.tree.edges) {
    const children = childrenByParent.get(edge.parentLineageNodeId);
    if (children) {
      children.push(edge.childLineageNodeId);
    } else {
      childrenByParent.set(edge.parentLineageNodeId, [edge.childLineageNodeId]);
    }
  }

  const ordered: Array<{ lineageNodeId: string; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (lineageNodeId: string, depth: number): void => {
    if (visited.has(lineageNodeId) || !nodesById.has(lineageNodeId)) {
      return;
    }
    visited.add(lineageNodeId);
    ordered.push({ lineageNodeId, depth });
    for (const childId of childrenByParent.get(lineageNodeId) ?? []) {
      visit(childId, depth + 1);
    }
  };
  visit(input.tree.rootNodeId, 0);
  for (const node of input.tree.nodes) {
    visit(node.lineageNodeId, 0);
  }

  const nodes = ordered.flatMap(({ lineageNodeId, depth }) => {
    const node = nodesById.get(lineageNodeId);
    if (!node) {
      return [];
    }
    return [
      {
        lineageNodeId: node.lineageNodeId,
        parentLineageNodeId: node.parentLineageNodeId,
        leafEntryId: input.leafEntryIdsByLineageNodeId?.get(node.lineageNodeId) ?? null,
        kind: node.kind,
        title: node.title ?? null,
        depth,
        current: node.lineageNodeId === input.currentLineageNodeId,
        childCount: childrenByParent.get(node.lineageNodeId)?.length ?? 0,
        summaryCount: node.summaries.length,
        outcomeCount: node.outcomes.length,
        adoptedOutcomeCount: node.adoptedOutcomes.length,
        forkPoint: formatForkPoint(node.forkPoint),
      },
    ];
  });

  const selectedById =
    typeof input.selection?.lineageNodeId === "string"
      ? nodes.findIndex((node) => node.lineageNodeId === input.selection?.lineageNodeId)
      : -1;
  const currentIndex =
    input.currentLineageNodeId === null
      ? -1
      : nodes.findIndex((node) => node.lineageNodeId === input.currentLineageNodeId);

  return {
    kind: "lineage",
    sessionId: input.tree.sessionId,
    rootNodeId: input.tree.rootNodeId,
    currentLineageNodeId: input.currentLineageNodeId,
    nodes,
    selectedIndex:
      selectedById >= 0
        ? selectedById
        : currentIndex >= 0
          ? currentIndex
          : Math.max(0, Math.min(input.selection?.index ?? 0, Math.max(0, nodes.length - 1))),
  };
}

export function renderQueuePromptSummary(text: string, maxWidth = 72): string {
  const normalized = text.split(/\r?\n/u).join(" ").trim();
  const summary = normalized || "(empty prompt)";
  if (visibleWidth(summary) <= maxWidth) {
    return summary;
  }
  if (maxWidth <= 1) {
    return "…";
  }
  return `${truncateToWidth(summary, maxWidth - 1)}…`;
}

export function buildInboxOverlayPayload(
  snapshot: OperatorSurfaceSnapshot,
  notificationsSource: readonly CliOverlayNotification[],
  selection: {
    id?: string;
    index?: number;
  } = {},
): CliInboxOverlayPayload {
  const notifications = [...notificationsSource].toReversed();
  const items: CliInboxOverlayItem[] = [
    ...questionRequestsFromSnapshot(snapshot).map((request) => ({
      kind: "question" as const,
      id: `question:${request.requestId}`,
      requestId: request.requestId,
      sourceLabel: request.sourceLabel,
      summary: describeQuestionRequestSummary(request),
    })),
    ...notifications.map((notification) => ({
      kind: "notification" as const,
      id: `notification:${notification.id}`,
      notificationId: notification.id,
      level: notification.level,
      summary: notification.message,
    })),
  ];
  const selectedIndexById =
    typeof selection.id === "string" ? items.findIndex((item) => item.id === selection.id) : -1;
  return {
    kind: "inbox",
    snapshot,
    notifications,
    items,
    selectedIndex:
      selectedIndexById >= 0
        ? selectedIndexById
        : Math.max(0, Math.min(selection.index ?? 0, Math.max(0, items.length - 1))),
  };
}

export function mergeSessionsOverlayRows(
  snapshot: OperatorSurfaceSnapshot,
  currentSessionId: string,
): BrewvaReplaySession[] {
  const hasCurrentInSnapshot = snapshot.sessions.some(
    (session) => session.sessionId === currentSessionId,
  );
  const placeholderCurrent = {
    sessionId: asBrewvaSessionId(currentSessionId),
    eventCount: 0,
    lastEventAt: 0,
  } satisfies BrewvaReplaySession;
  return hasCurrentInSnapshot ? [...snapshot.sessions] : [placeholderCurrent, ...snapshot.sessions];
}

export function orderSessionsByStableIds(
  sessions: readonly BrewvaReplaySession[],
  stableIds: readonly string[],
): BrewvaReplaySession[] {
  const byId = new Map(sessions.map((s) => [String(s.sessionId), s]));
  const used = new Set<string>();
  const out: BrewvaReplaySession[] = [];
  for (const id of stableIds) {
    const row = byId.get(id);
    if (row) {
      out.push(row);
      used.add(id);
    }
  }
  for (const session of sessions) {
    const id = String(session.sessionId);
    if (!used.has(id)) {
      out.push(session);
    }
  }
  return out;
}

/**
 * Pure state step for the sessions overlay list: lock order on first call, keep it across snapshot
 * reshuffles, and optionally promote the current session after an interactive submit + eventCount bump.
 */
export function reconcileSessionsOverlayStableIds(input: {
  mergedSessions: readonly BrewvaReplaySession[];
  currentSessionId: string;
  stableOrderIds: readonly string[] | undefined;
  lastEventCounts: ReadonlyMap<string, number>;
  userPromptReorderGeneration: number;
  lastAppliedUserPromptReorderGeneration: number;
}): {
  stableOrderIds: string[];
  lastAppliedUserPromptReorderGeneration: number;
} {
  const merged = input.mergedSessions;
  if (input.stableOrderIds === undefined) {
    return {
      stableOrderIds: merged.map((session) => String(session.sessionId)),
      lastAppliedUserPromptReorderGeneration: input.lastAppliedUserPromptReorderGeneration,
    };
  }

  const availableIds = new Set(merged.map((session) => String(session.sessionId)));
  const currentRow = merged.find((session) => String(session.sessionId) === input.currentSessionId);
  const previousCurrentCount = input.lastEventCounts.get(input.currentSessionId) ?? 0;

  let nextOrder = [...input.stableOrderIds].filter((sessionId) => availableIds.has(sessionId));
  for (const session of merged) {
    const sid = String(session.sessionId);
    if (!nextOrder.includes(sid)) {
      nextOrder.push(sid);
    }
  }

  let lastApplied = input.lastAppliedUserPromptReorderGeneration;
  if (
    input.userPromptReorderGeneration > input.lastAppliedUserPromptReorderGeneration &&
    currentRow !== undefined &&
    currentRow.eventCount > previousCurrentCount
  ) {
    nextOrder = [
      input.currentSessionId,
      ...nextOrder.filter((sessionId) => sessionId !== input.currentSessionId),
    ];
    lastApplied = input.userPromptReorderGeneration;
  }

  return {
    stableOrderIds: nextOrder,
    lastAppliedUserPromptReorderGeneration: lastApplied,
  };
}

export function buildSessionsOverlayPayload(input: {
  snapshot: OperatorSurfaceSnapshot;
  currentSessionId: string;
  draftsBySessionId: ReadonlyMap<string, { text: string }>;
  currentComposerText: string;
  /**
   * Replay rows in display order — used by the sessions overlay to keep keyboard order stable
   * regardless of backend `lastEventAt` reshuffles until the user sends a prompt in the current session.
   */
  replaySessionsForOverlay?: readonly BrewvaReplaySession[];
  selection?: {
    sessionId?: string;
    index?: number;
  };
}): CliSessionsOverlayPayload {
  const sessions = input.replaySessionsForOverlay
    ? [...input.replaySessionsForOverlay]
    : mergeSessionsOverlayRows(input.snapshot, input.currentSessionId);
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

function renderLineageSelectionValue(selectedByChannel: Record<string, string>): string {
  const entries = Object.entries(selectedByChannel).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length > 0
    ? entries.map(([channelId, lineageNodeId]) => `${channelId}:${lineageNodeId}`).join(", ")
    : "none";
}

function formatForkPoint(forkPoint: ForkPoint): string {
  switch (forkPoint.kind) {
    case "session_root":
      return forkPoint.parentSessionId
        ? `session_root:${forkPoint.parentSessionId}`
        : "session_root";
    case "reasoning_checkpoint":
      return `reasoning_checkpoint:${forkPoint.reasoningCheckpointId}`;
    case "turn":
      return `turn:${forkPoint.turnId}`;
    case "context_entry":
      return `context_entry:${forkPoint.lineageNodeId}:${forkPoint.entryId}`;
    case "tool_call":
      return `tool_call:${forkPoint.toolCallId}`;
    case "patch_set":
      return `patch_set:${forkPoint.patchSetId}`;
    case "worker_run":
      return `worker_run:${forkPoint.workerRunId}`;
    default:
      forkPoint satisfies never;
      return "unknown";
  }
}

function renderNotificationSummary(notification: {
  level: "info" | "warning" | "error";
  message: string;
}): string {
  return `[${notification.level}] ${notification.message}`;
}

export function buildNotificationDetailLines(notification: CliOverlayNotification): string[] {
  return [
    `id: ${notification.id}`,
    `level: ${notification.level}`,
    `createdAt: ${new Date(notification.createdAt).toISOString()}`,
    "",
    ...notification.message.split(/\r?\n/u),
  ];
}

function renderInboxItemSummary(item: CliInboxOverlayItem): string {
  if (item.kind === "question") {
    return `[question] ${item.sourceLabel} :: ${item.summary}`;
  }
  return `[${item.level}] ${item.summary}`;
}
