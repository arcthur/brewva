/** @jsxImportSource @opentui/solid */

import { For, Show, createEffect, createMemo } from "solid-js";
import { padToWidth, visibleWidth } from "../../../src/internal/tui/index.js";
import type {
  CliAuthMethodPickerOverlayPayload,
  CliCommandPaletteOverlayPayload,
  CliHelpHubOverlayPayload,
  CliModelPickerOverlayPayload,
  CliProviderPickerOverlayPayload,
  CliThinkingPickerOverlayPayload,
} from "../../../src/shell/domain/overlays/payloads.js";
import type { OpenTuiScrollBoxHandle } from "../../internal-opentui-runtime.js";
import { TextAttributes } from "../../opentui/index.js";
import {
  DIALOG_FOOTER_RIGHT_PADDING,
  DIALOG_HORIZONTAL_PADDING,
  resolveCommandPaletteTopInset,
  resolveDialogContentWidth,
  resolveDialogSurfaceDimensions,
  resolveDialogTopInset,
  resolveHighDensityPickerRows,
  resolveModelPickerTopInset,
} from "../overlay-style.js";
import { DEFAULT_SCROLL_ACCELERATION, type SessionPalette } from "../palette.js";
import { TextLineBlock } from "../transcript.js";
import { visibleLineWindow } from "../utils.js";
import { DialogSelectFrame, OverlaySurface, truncateDialogText } from "./frame.js";

/** Fixed-width marker column shared by all picker rows. */
const PICKER_MARKER_WIDTH = 2;

type PickerListItem = {
  id: string;
  section?: string;
  label: string;
  detail?: string;
  footer?: string;
  marker?: string;
  disabled?: boolean;
};

type PickerRenderRow =
  | { kind: "spacer"; key: string }
  | { kind: "section"; key: string; section: string }
  | { kind: "item"; key: string; item: PickerListItem; itemIndex: number };

type PickerRowVariant = "default" | "palette";

function buildPickerRenderRows(
  items: readonly PickerListItem[],
  input: { startIndex?: number; previousItem?: PickerListItem } = {},
): PickerRenderRow[] {
  const rows: PickerRenderRow[] = [];
  const startIndex = input.startIndex ?? 0;
  for (const [localIndex, item] of items.entries()) {
    const itemIndex = startIndex + localIndex;
    const previous = localIndex === 0 ? input.previousItem : items[localIndex - 1];
    if (item.section && item.section !== previous?.section) {
      if (itemIndex > 0) {
        rows.push({ kind: "spacer", key: `space:${item.section}:${itemIndex}` });
      }
      rows.push({
        kind: "section",
        key: `section:${item.section}:${itemIndex}`,
        section: item.section,
      });
    }
    rows.push({ kind: "item", key: `item:${item.id}:${itemIndex}`, item, itemIndex });
  }
  return rows;
}

function findPickerItemRow(
  rows: readonly PickerRenderRow[],
  selectedIndex: number,
): number | undefined {
  const rowIndex = rows.findIndex((row) => row.kind === "item" && row.itemIndex === selectedIndex);
  return rowIndex >= 0 ? rowIndex : undefined;
}

function SearchLine(input: { query: string; theme: SessionPalette }) {
  return (
    <box paddingTop={1} flexShrink={0}>
      <text fg={input.theme.textMuted} wrapMode="none">
        {input.query ? `Search ${input.query}` : "Search"}
      </text>
    </box>
  );
}

function PickerRows(input: {
  rows: readonly PickerRenderRow[];
  selectedIndex: number;
  theme: SessionPalette;
  variant: PickerRowVariant;
  width?: number;
}) {
  const contentWidth = createMemo(() => Math.max(1, input.width ?? 60));
  const markerWidth = createMemo(() => (input.variant === "palette" ? 0 : PICKER_MARKER_WIDTH));
  const renderSectionRow = (section: string) => (
    <box paddingLeft={DIALOG_HORIZONTAL_PADDING} flexShrink={0}>
      <text fg={input.theme.accent} attributes={TextAttributes.BOLD}>
        {section}
      </text>
    </box>
  );
  const renderItemRow = (item: PickerListItem, itemIndex: number) => {
    const selected = createMemo(() => itemIndex === input.selectedIndex);
    const detail = createMemo(() =>
      input.variant !== "palette" && item.detail
        ? truncateDialogText(item.detail, Math.min(24, Math.floor(contentWidth() / 3)))
        : undefined,
    );
    const footer = createMemo(() => {
      if (!item.footer) {
        return undefined;
      }
      const defaultMaxWidth = Math.min(18, Math.floor(contentWidth() / 4));
      const maxWidth =
        input.variant === "palette"
          ? Math.max(1, contentWidth() - DIALOG_HORIZONTAL_PADDING * 2 - 1)
          : defaultMaxWidth;
      return truncateDialogText(item.footer, maxWidth);
    });
    const label = createMemo(() => {
      const detailWidth = detail() ? visibleWidth(detail()!) + 1 : 0;
      const footerWidth = footer() ? visibleWidth(footer()!) + 1 : 0;
      // paddingLeft subtracts the marker column so label text starts at
      // DIALOG_HORIZONTAL_PADDING (same as the dialog title).
      // Total row chrome: leftPad + markerCol + rightPad = 2 * DIALOG_HORIZONTAL_PADDING.
      const rowChromeWidth = DIALOG_HORIZONTAL_PADDING * 2;
      const availableWidth = contentWidth() - detailWidth - footerWidth - rowChromeWidth;
      const maxLabelWidth =
        input.variant === "palette" ? availableWidth : Math.min(61, availableWidth);
      return truncateDialogText(item.label, Math.max(1, maxLabelWidth));
    });
    return (
      <box
        width="100%"
        flexDirection="row"
        backgroundColor={selected() ? input.theme.primary : undefined}
        paddingLeft={DIALOG_HORIZONTAL_PADDING - markerWidth()}
        paddingRight={DIALOG_HORIZONTAL_PADDING}
        flexShrink={0}
        gap={0}
      >
        <Show when={markerWidth() > 0}>
          {/*
            Fixed-width marker column shared by picker rows so the label
            always starts at the same column regardless of marker presence
            or marker visible width (● = 1, ✓ = 2 in opentui's table).
          */}
          <box width={markerWidth()} flexShrink={0}>
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
              {padToWidth(item.marker ?? "", markerWidth())}
            </text>
          </box>
        </Show>
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
    );
  };
  return (
    <For each={input.rows}>
      {(row) => {
        if (row.kind === "spacer") {
          return <box height={1} flexShrink={0} />;
        }
        if (row.kind === "section") {
          return renderSectionRow(row.section);
        }
        return renderItemRow(row.item, row.itemIndex);
      }}
    </For>
  );
}

function PickerList(input: {
  id: string;
  items: readonly PickerListItem[];
  selectedIndex: number;
  theme: SessionPalette;
  width: number;
  height: number;
  topInset: number;
  variant: PickerRowVariant;
  resetKey?: string;
}) {
  let scrollbox: OpenTuiScrollBoxHandle | undefined;
  let previousResetKey: string | undefined;
  const rows = createMemo(() => buildPickerRenderRows(input.items));
  const viewportRows = createMemo(() =>
    resolveHighDensityPickerRows(input.height, rows().length, input.topInset),
  );
  createEffect(() => {
    const node = scrollbox;
    if (!node || node.isDestroyed) {
      return;
    }
    const resetKey = input.resetKey;
    if (resetKey !== previousResetKey) {
      previousResetKey = resetKey;
      node.scrollTo(0);
    }
    const selectedRow = findPickerItemRow(rows(), input.selectedIndex);
    if (selectedRow === undefined) {
      node.scrollTo(0);
      return;
    }
    const viewportHeight = Math.max(1, node.viewport.height || viewportRows());
    const scrollBottom = node.scrollTop + viewportHeight;
    if (selectedRow < node.scrollTop) {
      node.scrollBy(selectedRow - node.scrollTop);
      return;
    }
    if (selectedRow + 1 > scrollBottom) {
      node.scrollBy(selectedRow + 1 - scrollBottom);
    }
  });
  return (
    <scrollbox
      id={input.id}
      ref={(node: OpenTuiScrollBoxHandle) => {
        scrollbox = node;
      }}
      width="100%"
      height={viewportRows()}
      scrollbarOptions={{ visible: false }}
      scrollAcceleration={DEFAULT_SCROLL_ACCELERATION}
    >
      <PickerRows
        rows={rows()}
        selectedIndex={input.selectedIndex}
        theme={input.theme}
        width={input.width}
        variant={input.variant}
      />
    </scrollbox>
  );
}

export function ModelPickerOverlay(input: {
  payload: CliModelPickerOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const listWidth = createMemo(() => resolveDialogContentWidth(input.width));
  const topInset = createMemo(() => resolveModelPickerTopInset(input.height));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      topInset={topInset()}
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
        <PickerList
          id="model-picker-scrollbox"
          items={input.payload.items}
          selectedIndex={input.payload.selectedIndex}
          theme={input.theme}
          width={listWidth()}
          height={input.height}
          topInset={topInset()}
          variant="default"
          resetKey={input.payload.query}
        />
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
  const topInset = createMemo(() => resolveDialogTopInset(input.height));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      topInset={topInset()}
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
      <PickerList
        id="provider-picker-scrollbox"
        items={input.payload.items}
        selectedIndex={input.payload.selectedIndex}
        theme={input.theme}
        width={listWidth()}
        height={input.height}
        topInset={topInset()}
        variant="default"
        resetKey={input.payload.query}
      />
    </DialogSelectFrame>
  );
}

export function ThinkingPickerOverlay(input: {
  payload: CliThinkingPickerOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const topInset = createMemo(() => resolveDialogTopInset(input.height));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      topInset={topInset()}
    >
      <PickerList
        id="thinking-picker-scrollbox"
        items={input.payload.items}
        selectedIndex={input.payload.selectedIndex}
        theme={input.theme}
        width={resolveDialogContentWidth(input.width)}
        height={input.height}
        topInset={topInset()}
        variant="default"
      />
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
  const topInset = createMemo(() => resolveDialogTopInset(input.height));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      topInset={topInset()}
    >
      <PickerList
        id="auth-method-picker-scrollbox"
        items={input.payload.items}
        selectedIndex={input.payload.selectedIndex}
        theme={input.theme}
        width={listWidth()}
        height={input.height}
        topInset={topInset()}
        variant="default"
      />
    </DialogSelectFrame>
  );
}

export function CommandPaletteOverlay(input: {
  payload: CliCommandPaletteOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const listWidth = createMemo(() => resolveDialogContentWidth(input.width, "large"));
  const topInset = createMemo(() => resolveCommandPaletteTopInset(input.height));
  return (
    <DialogSelectFrame
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      size="large"
      topInset={topInset()}
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
      <Show
        when={input.payload.items.length > 0}
        fallback={
          <box paddingLeft={DIALOG_HORIZONTAL_PADDING} paddingRight={DIALOG_HORIZONTAL_PADDING}>
            <text fg={input.theme.textMuted}>No results found</text>
          </box>
        }
      >
        <PickerList
          id="command-palette-scrollbox"
          items={input.payload.items}
          selectedIndex={input.payload.selectedIndex}
          theme={input.theme}
          width={listWidth()}
          height={input.height}
          topInset={topInset()}
          variant="palette"
          resetKey={input.payload.query}
        />
      </Show>
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
