import {
  countQuestionRequestKinds,
  describeQuestionRequestSummary,
  questionRequestsFromOverlay,
  questionRequestsFromSnapshot,
  resolveQuestionOverlayTitle,
} from "../../question-utils.js";
import { buildTaskRunListLabel, buildTaskRunPreviewLines } from "../../task-details.js";
import type { CliInboxOverlayItem, CliShellOverlayPayload } from "../payloads.js";
import { renderNotificationSummary } from "./notifications.js";
import { renderQueuePromptSummary } from "./queue.js";
import { buildSessionsOverlayRows } from "./sessions.js";

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
          `${marker} [${item.requestId}] ${item.toolName} :: ${item.subject} :: ${(item.effects ?? []).join(", ")}`,
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
        `Search: ${payload.query}`,
        "Use ↑/↓ to choose, type to search, Enter to switch, Esc to close.",
      ];
      for (const row of buildSessionsOverlayRows(payload.sessions)) {
        if (row.kind === "group") {
          lines.push(row.label);
          continue;
        }
        const item = row.session;
        const marker = row.sessionIndex === payload.selectedIndex ? ">" : " ";
        const draft = payload.draftStateBySessionId[item.sessionId];
        const draftText = draft ? ` draft=${draft.lines}l/${draft.characters}c` : "";
        lines.push(`${marker} ${item.title}${draftText}`);
      }
      if (payload.sessions.length === 0) {
        lines.push(payload.query.trim() ? "No matching sessions." : "No sessions found.");
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
          payload.footer ?? "Type to filter.",
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
    case "context":
      return {
        title: "Context",
        lines: payload.lines,
      };
    case "authority":
      return {
        title: "Authority",
        lines: payload.lines,
      };
    case "skills":
      return {
        title: payload.title,
        lines: [
          payload.summary,
          `Search: ${payload.query}`,
          "Enter inserts $skill; Ctrl+N/Ctrl+P move; Esc closes.",
          "",
          ...(payload.items.length > 0
            ? renderPickerInspectLines(payload.items, payload.selectedIndex)
            : [payload.emptyMessage ?? "No skills are loaded."]),
        ],
      };
    case "shortcutOverlay":
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

function renderInboxItemSummary(item: CliInboxOverlayItem): string {
  if (item.kind === "question") {
    return `[question] ${item.sourceLabel} :: ${item.summary}`;
  }
  return `[${item.level}] ${item.summary}`;
}
