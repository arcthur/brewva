/** @jsxImportSource @opentui/solid */

import { padToWidth, visibleWidth } from "@brewva/brewva-tui";
import { For, Show, createMemo } from "solid-js";
import type {
  CliAuthMethodPickerOverlayPayload,
  CliCommandPaletteOverlayPayload,
  CliHelpHubOverlayPayload,
  CliModelPickerOverlayPayload,
  CliProviderPickerOverlayPayload,
  CliThinkingPickerOverlayPayload,
} from "../../../src/shell/domain/overlays/payloads.js";
import { TextAttributes } from "../../opentui/index.js";
import {
  DIALOG_FOOTER_RIGHT_PADDING,
  DIALOG_HORIZONTAL_PADDING,
  resolveDialogContentWidth,
  resolveDialogSelectRows,
  resolveDialogSurfaceDimensions,
} from "../overlay-style.js";
import type { SessionPalette } from "../palette.js";
import { TextLineBlock } from "../transcript.js";
import { visibleLineWindow, windowSelection } from "../utils.js";
import { DialogSelectFrame, OverlaySurface, truncateDialogText } from "./frame.js";

/** Fixed-width marker column shared by all picker rows. */
const PICKER_MARKER_WIDTH = 2;

function SearchLine(input: { query: string; theme: SessionPalette }) {
  return (
    <box paddingTop={1} flexShrink={0}>
      <text fg={input.theme.textMuted} wrapMode="none">
        {input.query ? `Search ${input.query}` : "Search"}
      </text>
    </box>
  );
}

function PickerList(input: {
  items: readonly {
    id: string;
    section?: string;
    label: string;
    detail?: string;
    footer?: string;
    marker?: string;
    disabled?: boolean;
  }[];
  selectedIndex: number;
  theme: SessionPalette;
  width?: number;
  maxVisible?: number;
}) {
  const selectionWindow = createMemo(() =>
    windowSelection(input.items, input.selectedIndex, input.maxVisible ?? 12),
  );
  const contentWidth = createMemo(() => Math.max(1, input.width ?? 60));
  return (
    <box width="100%" flexDirection="column" flexGrow={1}>
      <For each={selectionWindow().items}>
        {(item, index) => {
          const absoluteIndex = createMemo(() => selectionWindow().startIndex + index());
          const previous = createMemo(() => input.items[absoluteIndex() - 1]);
          const selected = createMemo(() => absoluteIndex() === input.selectedIndex);
          const showSection = createMemo(
            () => item.section && item.section !== previous()?.section,
          );
          const detail = createMemo(() =>
            item.detail
              ? truncateDialogText(item.detail, Math.min(24, Math.floor(contentWidth() / 3)))
              : undefined,
          );
          const footer = createMemo(() =>
            item.footer
              ? truncateDialogText(item.footer, Math.min(18, Math.floor(contentWidth() / 4)))
              : undefined,
          );
          const label = createMemo(() => {
            const detailWidth = detail() ? visibleWidth(detail()!) + 1 : 0;
            const footerWidth = footer() ? visibleWidth(footer()!) + 1 : 0;
            // paddingLeft is DIALOG_HORIZONTAL_PADDING - PICKER_MARKER_WIDTH so label text
            // starts at column DIALOG_HORIZONTAL_PADDING (same as the dialog title).
            // Total row chrome: leftPad + markerCol + rightPad = 2 * DIALOG_HORIZONTAL_PADDING.
            const rowChromeWidth = DIALOG_HORIZONTAL_PADDING * 2;
            const availableWidth = contentWidth() - detailWidth - footerWidth - rowChromeWidth;
            return truncateDialogText(item.label, Math.max(1, Math.min(61, availableWidth)));
          });
          return (
            <>
              <Show when={showSection()}>
                <box
                  paddingTop={absoluteIndex() === 0 ? 0 : 1}
                  paddingLeft={DIALOG_HORIZONTAL_PADDING}
                  flexShrink={0}
                >
                  <text fg={input.theme.accent} attributes={TextAttributes.BOLD}>
                    {item.section}
                  </text>
                </box>
              </Show>
              <box
                width="100%"
                flexDirection="row"
                backgroundColor={selected() ? input.theme.primary : undefined}
                paddingLeft={DIALOG_HORIZONTAL_PADDING - PICKER_MARKER_WIDTH}
                paddingRight={DIALOG_HORIZONTAL_PADDING}
                flexShrink={0}
                gap={0}
              >
                {/*
                  Fixed-width marker column shared by all rows so the label always
                  starts at the same column regardless of marker presence or marker
                  visible width (● = 1, ✓ = 2 in opentui's east-asian-width table).
                  Marker text is padded to exactly PICKER_MARKER_WIDTH visible cells.
                */}
                <box width={PICKER_MARKER_WIDTH} flexShrink={0}>
                  <text
                    fg={
                      selected()
                        ? input.theme.selectionText
                        : item.disabled
                          ? input.theme.textMuted
                          : input.theme.primary
                    }
                    wrapMode="none"
                  >
                    {padToWidth(item.marker ?? "", PICKER_MARKER_WIDTH)}
                  </text>
                </box>
                <text
                  flexGrow={1}
                  fg={
                    selected()
                      ? input.theme.selectionText
                      : item.disabled
                        ? input.theme.textMuted
                        : input.theme.text
                  }
                  attributes={selected() ? TextAttributes.BOLD : undefined}
                  overflow="hidden"
                  wrapMode="none"
                >
                  {label()}
                  <Show when={detail()}>
                    {(value) => (
                      <span
                        style={{
                          fg: selected() ? input.theme.selectionText : input.theme.textMuted,
                        }}
                      >
                        {` ${value()}`}
                      </span>
                    )}
                  </Show>
                </text>
                <Show when={footer()}>
                  {(value) => (
                    <box flexShrink={0}>
                      <text
                        fg={selected() ? input.theme.selectionText : input.theme.textMuted}
                        wrapMode="none"
                      >
                        {value()}
                      </text>
                    </box>
                  )}
                </Show>
              </box>
            </>
          );
        }}
      </For>
    </box>
  );
}

export function ModelPickerOverlay(input: {
  payload: CliModelPickerOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const listWidth = createMemo(() => resolveDialogContentWidth(input.width));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      search={<SearchLine query={input.payload.query} theme={input.theme} />}
      footer={
        <box
          paddingRight={DIALOG_FOOTER_RIGHT_PADDING}
          paddingLeft={DIALOG_HORIZONTAL_PADDING}
          paddingTop={1}
          flexDirection="row"
          gap={2}
        >
          <text fg={input.theme.text}>
            Connect provider <span style={{ fg: input.theme.textMuted }}>c</span>
          </text>
          <text fg={input.theme.text}>
            Favorite <span style={{ fg: input.theme.textMuted }}>f</span>
          </text>
        </box>
      }
    >
      <Show
        when={input.payload.items.length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={input.theme.textMuted}>{input.payload.emptyMessage ?? "No models"}</text>
          </box>
        }
      >
        <box paddingLeft={1} paddingRight={1}>
          <PickerList
            items={input.payload.items}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            width={listWidth()}
            maxVisible={resolveDialogSelectRows(input.height, input.payload.items.length)}
          />
        </box>
      </Show>
    </DialogSelectFrame>
  );
}

export function ProviderPickerOverlay(input: {
  payload: CliProviderPickerOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const listWidth = createMemo(() => resolveDialogContentWidth(input.width));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      search={<SearchLine query={input.payload.query} theme={input.theme} />}
      footer={
        <box
          paddingRight={DIALOG_FOOTER_RIGHT_PADDING}
          paddingLeft={DIALOG_HORIZONTAL_PADDING}
          paddingTop={1}
        >
          <text fg={input.theme.text}>
            Disconnect <span style={{ fg: input.theme.textMuted }}>d</span>
          </text>
        </box>
      }
    >
      <box paddingLeft={1} paddingRight={1}>
        <PickerList
          items={input.payload.items}
          selectedIndex={input.payload.selectedIndex}
          theme={input.theme}
          width={listWidth()}
          maxVisible={resolveDialogSelectRows(input.height, input.payload.items.length)}
        />
      </box>
    </DialogSelectFrame>
  );
}

export function ThinkingPickerOverlay(input: {
  payload: CliThinkingPickerOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
    >
      <box paddingLeft={1} paddingRight={1}>
        <PickerList
          items={input.payload.items}
          selectedIndex={input.payload.selectedIndex}
          theme={input.theme}
          width={resolveDialogContentWidth(input.width)}
          maxVisible={resolveDialogSelectRows(input.height, input.payload.items.length)}
        />
      </box>
    </DialogSelectFrame>
  );
}

export function AuthMethodPickerOverlay(input: {
  payload: CliAuthMethodPickerOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const listWidth = createMemo(() => resolveDialogContentWidth(input.width));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
    >
      <box paddingLeft={1} paddingRight={1}>
        <PickerList
          items={input.payload.items}
          selectedIndex={input.payload.selectedIndex}
          theme={input.theme}
          width={listWidth()}
          maxVisible={resolveDialogSelectRows(input.height, input.payload.items.length)}
        />
      </box>
    </DialogSelectFrame>
  );
}

export function CommandPaletteOverlay(input: {
  payload: CliCommandPaletteOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const listWidth = createMemo(() => resolveDialogContentWidth(input.width));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      size="large"
      verticalAlign="center"
      search={
        <box paddingTop={1}>
          <text fg={input.theme.textMuted}>Search: {input.payload.query}</text>
        </box>
      }
      footer={
        <box paddingLeft={DIALOG_HORIZONTAL_PADDING} paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <text fg={input.theme.textMuted}>Enter run · Esc close · type to search</text>
        </box>
      }
    >
      <PickerList
        items={input.payload.items}
        selectedIndex={input.payload.selectedIndex}
        theme={input.theme}
        width={listWidth()}
        maxVisible={resolveDialogSelectRows(input.height, input.payload.items.length)}
      />
    </DialogSelectFrame>
  );
}

export function HelpHubOverlay(input: {
  payload: CliHelpHubOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const surface = createMemo(() => resolveDialogSurfaceDimensions(input.width, input.height));
  const lineWindow = createMemo(() =>
    visibleLineWindow(input.payload.lines, 0, surface().contentHeight),
  );
  return (
    <OverlaySurface
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter/Esc close"
    >
      <TextLineBlock lines={lineWindow().visibleLines} color={input.theme.text} />
    </OverlaySurface>
  );
}
