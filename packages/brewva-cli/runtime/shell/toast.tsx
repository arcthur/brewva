/** @jsxImportSource @opentui/solid */

import { Show, createMemo } from "solid-js";
import type { CliShellNotification } from "../../src/shell/state/index.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import { renderNotificationSummary } from "./utils.js";

export function ToastStrip(input: {
  notifications: readonly CliShellNotification[];
  theme: SessionPalette;
}) {
  const latest = createMemo(() => input.notifications.at(-1));
  return (
    <Show when={latest()}>
      <box
        position="absolute"
        zIndex={20}
        top={1}
        right={2}
        border={["left"]}
        customBorderChars={SPLIT_BORDER_CHARS}
        borderColor={
          latest()!.level === "error"
            ? input.theme.error
            : latest()!.level === "warning"
              ? input.theme.warning
              : input.theme.border
        }
        backgroundColor={input.theme.backgroundPanel}
        paddingLeft={1}
        paddingRight={1}
      >
        <text
          fg={
            latest()!.level === "error"
              ? input.theme.error
              : latest()!.level === "warning"
                ? input.theme.warning
                : input.theme.text
          }
        >
          {renderNotificationSummary(latest()!)} · Ctrl+N inbox
        </text>
      </box>
    </Show>
  );
}
