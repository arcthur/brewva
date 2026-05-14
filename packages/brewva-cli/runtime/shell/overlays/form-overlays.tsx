/** @jsxImportSource @opentui/solid */

import { Show, createMemo } from "solid-js";
import type {
  CliConfirmOverlayPayload,
  CliInputOverlayPayload,
  CliOAuthWaitOverlayPayload,
  CliSelectOverlayPayload,
} from "../../../src/shell/domain/overlays/payloads.js";
import {
  DIALOG_HORIZONTAL_PADDING,
  resolveDialogWidth,
  resolveOverlaySurfaceSelectionRows,
} from "../overlay-style.js";
import type { SessionPalette } from "../palette.js";
import {
  DialogFrame,
  DialogHeader,
  OverlaySurface,
  SelectionList,
  truncateDialogText,
} from "./frame.js";

export function InputOverlay(input: {
  payload: CliInputOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const displayValue = createMemo(() =>
    input.payload.masked ? "*".repeat(input.payload.value.length) : input.payload.value,
  );
  if (input.payload.compact) {
    const surfaceWidth = createMemo(() => resolveDialogWidth(input.width, "medium"));
    const contentWidth = createMemo(() =>
      Math.max(1, surfaceWidth() - DIALOG_HORIZONTAL_PADDING * 2),
    );
    return (
      <DialogFrame width={input.width} height={input.height} theme={input.theme} size="medium">
        <box
          width="100%"
          flexDirection="column"
          gap={1}
          paddingLeft={DIALOG_HORIZONTAL_PADDING}
          paddingRight={DIALOG_HORIZONTAL_PADDING}
          paddingBottom={1}
        >
          <DialogHeader title={input.payload.title ?? "Input"} theme={input.theme} />
          <Show when={input.payload.message}>
            <text fg={input.theme.textMuted} wrapMode="none">
              {truncateDialogText(input.payload.message ?? "", contentWidth())}
            </text>
          </Show>
          <box flexDirection="row">
            <text fg={input.theme.primary}>› </text>
            <text fg={input.theme.text} wrapMode="none">
              {truncateDialogText(displayValue(), Math.max(1, contentWidth() - 2))}
            </text>
          </box>
          <text fg={input.theme.textMuted}>Enter confirm · Esc cancel</text>
        </box>
      </DialogFrame>
    );
  }
  return (
    <OverlaySurface
      title={input.payload.title ?? "Input"}
      width={input.width}
      height={input.height}
      theme={input.theme}
      size="medium"
      footer="Enter confirm · Esc cancel"
    >
      <box flexDirection="column" gap={1}>
        <Show when={input.payload.message}>
          <text fg={input.theme.textMuted}>{input.payload.message}</text>
        </Show>
        <box
          border={true}
          borderColor={input.theme.borderSubtle}
          backgroundColor={input.theme.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={input.theme.text}>{displayValue()}</text>
        </box>
      </box>
    </OverlaySurface>
  );
}

export function OAuthWaitOverlay(input: {
  payload: CliOAuthWaitOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  return (
    <DialogFrame width={input.width} height={input.height} theme={input.theme}>
      <box
        paddingLeft={DIALOG_HORIZONTAL_PADDING}
        paddingRight={DIALOG_HORIZONTAL_PADDING}
        gap={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box>
          <DialogHeader title={input.payload.title} theme={input.theme} />
        </box>
        <box flexDirection="column" gap={1}>
          <text fg={input.theme.primary}>{input.payload.url}</text>
          <text fg={input.theme.textMuted}>{input.payload.instructions}</text>
        </box>
        <text fg={input.theme.textMuted}>Waiting for authorization...</text>
        <text fg={input.theme.text}>
          <Show
            when={input.payload.manualCodePrompt}
            fallback={
              <>
                c <span style={{ fg: input.theme.textMuted }}>copy</span>
              </>
            }
          >
            enter/p <span style={{ fg: input.theme.textMuted }}>paste callback</span>
            {"  "}c <span style={{ fg: input.theme.textMuted }}>copy</span>
          </Show>
        </text>
      </box>
    </DialogFrame>
  );
}

export function SelectOverlay(input: {
  payload: CliSelectOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const listRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(
      input.width,
      input.height,
      input.payload.options.length,
      "medium",
    ),
  );
  return (
    <OverlaySurface
      title="Select"
      width={input.width}
      height={input.height}
      theme={input.theme}
      size="medium"
      footer="Enter confirm · Esc cancel"
    >
      <SelectionList
        items={input.payload.options}
        selectedIndex={input.payload.selectedIndex}
        theme={input.theme}
        maxVisible={listRows()}
      />
    </OverlaySurface>
  );
}

export function ConfirmDialogOverlay(input: {
  payload: CliConfirmOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  return (
    <OverlaySurface
      title="Confirm"
      width={input.width}
      height={input.height}
      theme={input.theme}
      size="medium"
      footer="Enter/y confirm · n/Esc cancel"
    >
      <text fg={input.theme.text}>{input.payload.message}</text>
    </OverlaySurface>
  );
}
