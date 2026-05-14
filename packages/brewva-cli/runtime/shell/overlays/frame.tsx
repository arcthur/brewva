/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo, type JSX } from "solid-js";
import { truncateToWidth, visibleWidth } from "../../../src/internal/tui/index.js";
import { TextAttributes } from "../../opentui/index.js";
import {
  DIALOG_BACKDROP,
  DIALOG_FOOTER_RIGHT_PADDING,
  DIALOG_HORIZONTAL_PADDING,
  DIALOG_Z_INDEX,
  type DialogSize,
  resolveDialogSurfaceDimensions,
  resolveDialogTopInset,
  resolveDialogWidth,
} from "../overlay-style.js";
import type { SessionPalette } from "../palette.js";
import { useShellRenderContext } from "../render-context.js";
import { windowSelection } from "../utils.js";

export function truncateDialogText(text: string, maxWidth: number): string {
  const boundedWidth = Math.max(0, Math.trunc(maxWidth));
  if (boundedWidth <= 0) {
    return "";
  }
  if (visibleWidth(text) <= boundedWidth) {
    return text;
  }
  if (boundedWidth === 1) {
    return "…";
  }
  return `${truncateToWidth(text, boundedWidth - 1)}…`;
}

export function DialogFrame(input: {
  width: number;
  height: number;
  theme: SessionPalette;
  size?: DialogSize;
  verticalAlign?: "topInset" | "center";
  topInset?: number;
  children: JSX.Element;
}) {
  const ctx = useShellRenderContext();
  const verticalAlign = input.verticalAlign ?? "topInset";
  return (
    <box
      position="absolute"
      zIndex={DIALOG_Z_INDEX}
      left={0}
      top={0}
      width={input.width}
      height={input.height}
      backgroundColor={DIALOG_BACKDROP}
      flexDirection="column"
      alignItems="center"
      justifyContent={verticalAlign === "center" ? "center" : undefined}
      paddingTop={
        verticalAlign === "center" ? 0 : (input.topInset ?? resolveDialogTopInset(input.height))
      }
      onMouseUp={() => {
        void ctx.runtime.handleInput({
          key: "escape",
          ctrl: false,
          meta: false,
          shift: false,
        });
      }}
    >
      <box
        width={resolveDialogWidth(input.width, input.size)}
        backgroundColor={input.theme.backgroundPanel}
        paddingTop={1}
        onMouseUp={(e) => {
          e.stopPropagation();
        }}
      >
        {input.children}
      </box>
    </box>
  );
}

export function DialogHeader(input: { title: string; theme: SessionPalette }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={input.theme.text} attributes={TextAttributes.BOLD}>
        {input.title}
      </text>
      <text fg={input.theme.textMuted}>esc</text>
    </box>
  );
}

export function DialogSelectFrame(input: {
  width: number;
  height: number;
  title: string;
  theme: SessionPalette;
  size?: DialogSize;
  verticalAlign?: "topInset" | "center";
  topInset?: number;
  search?: JSX.Element;
  children: JSX.Element;
  footer?: JSX.Element;
}) {
  return (
    <DialogFrame
      width={input.width}
      height={input.height}
      theme={input.theme}
      size={input.size}
      verticalAlign={input.verticalAlign}
      topInset={input.topInset}
    >
      <box gap={1} paddingBottom={1}>
        <box paddingLeft={DIALOG_HORIZONTAL_PADDING} paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <DialogHeader title={input.title} theme={input.theme} />
          {input.search}
        </box>
        {input.children}
        {input.footer}
      </box>
    </DialogFrame>
  );
}

export function OverlaySurface(input: {
  width: number;
  height: number;
  title: string;
  theme: SessionPalette;
  size?: DialogSize;
  footer?: string;
  /**
   * When true, dialog body ({input.children}) is not wrapped in horizontal padding so split
   * sidebars match command-style pickers (full-width selection bars from dialog left).
   */
  splitContent?: boolean;
  children: JSX.Element;
}) {
  const dimensions = createMemo(() =>
    resolveDialogSurfaceDimensions(input.width, input.height, input.size ?? "large"),
  );
  const footer = createMemo(() =>
    input.footer
      ? truncateDialogText(
          input.footer,
          Math.max(
            12,
            dimensions().surfaceWidth - DIALOG_HORIZONTAL_PADDING - DIALOG_FOOTER_RIGHT_PADDING,
          ),
        )
      : undefined,
  );
  return (
    <DialogFrame
      width={input.width}
      height={input.height}
      theme={input.theme}
      size={input.size ?? "large"}
    >
      <box width="100%" height={dimensions().surfaceHeight} flexDirection="column">
        <box
          width="100%"
          paddingLeft={DIALOG_HORIZONTAL_PADDING}
          paddingRight={DIALOG_HORIZONTAL_PADDING}
          flexShrink={0}
        >
          <DialogHeader title={input.title} theme={input.theme} />
        </box>
        <box
          width="100%"
          height={dimensions().contentHeight}
          flexDirection="column"
          {...(input.splitContent
            ? {}
            : {
                paddingLeft: DIALOG_HORIZONTAL_PADDING,
                paddingRight: DIALOG_HORIZONTAL_PADDING,
              })}
          paddingTop={1}
          flexShrink={0}
        >
          {input.children}
        </box>
        <Show when={footer()}>
          <box
            width="100%"
            flexDirection="row"
            justifyContent="space-between"
            paddingLeft={DIALOG_HORIZONTAL_PADDING}
            paddingRight={DIALOG_FOOTER_RIGHT_PADDING}
            paddingTop={1}
            paddingBottom={1}
            flexShrink={0}
          >
            <text fg={input.theme.textMuted}>{footer()}</text>
          </box>
        </Show>
      </box>
    </DialogFrame>
  );
}

export function SelectionList(input: {
  items: readonly string[];
  selectedIndex: number;
  theme: SessionPalette;
  maxVisible?: number;
  /** Flush labels to the sidebar edge (e.g. Inspect section titles). */
  flushLeading?: boolean;
}) {
  const leadingPad = () => (input.flushLeading ? 0 : DIALOG_HORIZONTAL_PADDING);
  const trailingPad = () => (input.flushLeading ? 1 : DIALOG_HORIZONTAL_PADDING);
  const selectionWindow = createMemo(() =>
    windowSelection(input.items, input.selectedIndex, input.maxVisible ?? 8),
  );
  return (
    <box width="100%" flexDirection="column" backgroundColor={input.theme.backgroundPanel}>
      <For each={selectionWindow().items}>
        {(item, index) => {
          const absoluteIndex = createMemo(() => selectionWindow().startIndex + index());
          const selected = createMemo(() => absoluteIndex() === input.selectedIndex);
          return (
            <box
              width="100%"
              flexDirection="row"
              backgroundColor={selected() ? input.theme.primary : undefined}
              paddingLeft={leadingPad()}
              paddingRight={trailingPad()}
              flexShrink={0}
            >
              <text
                flexGrow={1}
                fg={selected() ? input.theme.selectionText : input.theme.text}
                attributes={selected() ? TextAttributes.BOLD : undefined}
                overflow="hidden"
                wrapMode="none"
              >
                {item}
              </text>
            </box>
          );
        }}
      </For>
    </box>
  );
}
