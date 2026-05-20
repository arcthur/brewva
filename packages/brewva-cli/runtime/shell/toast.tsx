/** @jsxImportSource @opentui/solid */

import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { CliShellNotification } from "../../src/shell/domain/view-model.js";
import { useTerminalDimensions } from "../opentui/index.js";
import { TOAST_Z_INDEX, resolveToastMaxWidth } from "./overlay-style.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import { renderNotificationSummary } from "./utils.js";

const TOAST_VISIBLE_MS = 5_000;

function isToastVisible(notification: CliShellNotification, nowMs: number): boolean {
  return nowMs - notification.createdAt < TOAST_VISIBLE_MS;
}

export function ToastStrip(input: {
  notifications: readonly CliShellNotification[];
  theme: SessionPalette;
  inboxShortcutLabel?: string;
}) {
  const dimensions = useTerminalDimensions();
  const [nowMs, setNowMs] = createSignal(Date.now());
  createEffect(() => {
    const notification = input.notifications.at(-1);
    if (!notification) {
      return;
    }
    const now = Date.now();
    setNowMs(now);
    const remainingMs = TOAST_VISIBLE_MS - (now - notification.createdAt);
    if (remainingMs <= 0) {
      return;
    }
    const timer = setTimeout(() => setNowMs(Date.now()), remainingMs + 1);
    timer.unref?.();
    onCleanup(() => clearTimeout(timer));
  });
  const latest = createMemo(() => {
    const notification = input.notifications.at(-1);
    return notification && isToastVisible(notification, nowMs()) ? notification : undefined;
  });
  const toastWidth = createMemo(() => resolveToastMaxWidth(dimensions().width));
  const message = createMemo(() => {
    const notification = latest();
    if (!notification) {
      return "";
    }
    const summary = renderNotificationSummary(notification);
    return input.inboxShortcutLabel ? `${summary} · ${input.inboxShortcutLabel} inbox` : summary;
  });
  return (
    <Show when={latest()}>
      <box
        position="absolute"
        zIndex={TOAST_Z_INDEX}
        top={2}
        right={2}
        maxWidth={toastWidth()}
        border={["left", "right"]}
        customBorderChars={SPLIT_BORDER_CHARS}
        borderColor={
          latest()!.level === "error"
            ? input.theme.error
            : latest()!.level === "warning"
              ? input.theme.warning
              : input.theme.border
        }
        backgroundColor={input.theme.backgroundPanel}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <text
          fg={
            latest()!.level === "error"
              ? input.theme.error
              : latest()!.level === "warning"
                ? input.theme.warning
                : input.theme.text
          }
          wrapMode="word"
          width="100%"
        >
          {message()}
        </text>
      </box>
    </Show>
  );
}
