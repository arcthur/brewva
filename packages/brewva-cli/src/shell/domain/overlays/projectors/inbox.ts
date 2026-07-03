import type { OperatorSurfaceSnapshot } from "../../operator-snapshot.js";
import {
  describeQuestionRequestSummary,
  questionRequestsFromSnapshot,
} from "../../question-utils.js";
import type {
  CliInboxOverlayItem,
  CliInboxOverlayPayload,
  CliOverlayNotification,
} from "../payloads.js";

export function buildInboxOverlayPayload(
  snapshot: OperatorSurfaceSnapshot,
  notificationsSource: readonly CliOverlayNotification[],
  selection: {
    id?: string;
    index?: number;
    detailScrollOffset?: number;
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
    detailScrollOffset: Math.max(0, selection.detailScrollOffset ?? 0),
  };
}
