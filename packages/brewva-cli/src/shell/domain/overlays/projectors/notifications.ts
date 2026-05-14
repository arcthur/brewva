import type { CliNotificationsOverlayPayload, CliOverlayNotification } from "../payloads.js";

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

export function renderNotificationSummary(notification: {
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
