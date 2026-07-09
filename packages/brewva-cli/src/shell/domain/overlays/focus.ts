import type { CliShellOverlayPayload } from "./payloads.js";

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
    case "tree":
    case "worlds":
      return "dialog";
    case "notifications":
      return "notificationCenter";
    case "queue":
      return "dialog";
    case "inspect":
    case "cockpitArchive":
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
    case "shortcutOverlay":
    case "context":
    case "authority":
    case "cockpitAttention":
    case "skills":
      return "dialog";
    default: {
      const exhaustiveCheck: never = payload;
      return exhaustiveCheck;
    }
  }
}
