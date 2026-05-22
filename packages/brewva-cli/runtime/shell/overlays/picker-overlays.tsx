/** @jsxImportSource @opentui/solid */

import { For, Show, createEffect, createMemo } from "solid-js";
import { padToWidth, visibleWidth, wrapTextToLines } from "../../../src/internal/tui/index.js";
import type {
  CliAuthorityOverlayPayload,
  CliAuthMethodPickerOverlayPayload,
  CliCommandPaletteOverlayPayload,
  CliContextOverlayPayload,
  CliHelpHubOverlayPayload,
  CliModelPickerOverlayPayload,
  CliProviderPickerOverlayPayload,
  CliSkillsOverlayPayload,
  CliShortcutOverlayPayload,
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
  resolveDialogWidth,
  resolveHighDensityPickerRows,
  resolveModelPickerTopInset,
  resolveSkillsPickerRows,
} from "../overlay-style.js";
import type { SessionPalette } from "../palette.js";
import { useShellRenderContext } from "../render-context.js";
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

type PickerRowVariant = "default" | "palette" | "skills";

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

function findPickerItemVisualRange(
  rows: readonly PickerRenderRow[],
  selectedIndex: number,
  rowHeightFor: (row: PickerRenderRow) => number,
): { top: number; height: number } | undefined {
  let visualRowIndex = 0;
  for (const row of rows) {
    const rowHeight = rowHeightFor(row);
    if (row.kind === "item" && row.itemIndex === selectedIndex) {
      return { top: visualRowIndex, height: rowHeight };
    }
    visualRowIndex += rowHeight;
  }
  return undefined;
}

function resolveSkillsNameColumnWidth(rows: readonly PickerRenderRow[], contentWidth: number) {
  const maxLabelWidth = Math.max(
    12,
    ...rows
      .filter((row): row is Extract<PickerRenderRow, { kind: "item" }> => row.kind === "item")
      .map((row) => visibleWidth(row.item.label)),
  );
  return Math.min(maxLabelWidth, Math.max(12, Math.floor(contentWidth * 0.32)));
}

function resolveSkillsDescriptionWidth(contentWidth: number, nameColumnWidth: number): number {
  const rowChromeWidth = DIALOG_HORIZONTAL_PADDING * 2 + 2;
  return Math.max(12, contentWidth - rowChromeWidth - nameColumnWidth);
}

function wrapPickerText(text: string, width: number): string[] {
  const boundedWidth = Math.max(1, Math.trunc(width));
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  for (const word of normalized.split(" ")) {
    const wordWidth = visibleWidth(word);
    if (wordWidth > boundedWidth) {
      if (currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = "";
        currentWidth = 0;
      }
      lines.push(...wrapTextToLines(word, boundedWidth));
      continue;
    }

    if (currentLine.length === 0) {
      currentLine = word;
      currentWidth = wordWidth;
      continue;
    }

    if (currentWidth + 1 + wordWidth <= boundedWidth) {
      currentLine = `${currentLine} ${word}`;
      currentWidth += 1 + wordWidth;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
    currentWidth = wordWidth;
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
}

function pickerRenderRowHeight(
  row: PickerRenderRow,
  input: { variant: PickerRowVariant; contentWidth: number; skillsNameColumnWidth: number },
): number {
  if (row.kind !== "item" || input.variant !== "skills") {
    return 1;
  }
  const descriptionWidth = resolveSkillsDescriptionWidth(
    input.contentWidth,
    input.skillsNameColumnWidth,
  );
  return wrapPickerText(row.item.detail ?? "No description provided.", descriptionWidth).length;
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
  const skillsNameColumnWidth = createMemo(() => {
    if (input.variant !== "skills") {
      return 0;
    }
    return resolveSkillsNameColumnWidth(input.rows, contentWidth());
  });
  const renderSectionRow = (section: string) => (
    <box paddingLeft={DIALOG_HORIZONTAL_PADDING} flexShrink={0}>
      <text fg={input.theme.accent} attributes={TextAttributes.BOLD}>
        {section}
      </text>
    </box>
  );
  const renderItemRow = (item: PickerListItem, itemIndex: number) => {
    const selected = createMemo(() => itemIndex === input.selectedIndex);
    if (input.variant === "skills") {
      const descriptionWidth = createMemo(() => {
        return resolveSkillsDescriptionWidth(contentWidth(), skillsNameColumnWidth());
      });
      const descriptionLines = createMemo(() =>
        wrapPickerText(item.detail ?? "No description provided.", descriptionWidth()),
      );
      const rowHeight = createMemo(() => Math.max(1, descriptionLines().length));
      const rowTextColor = createMemo(() =>
        selected()
          ? input.theme.selectionText
          : item.disabled
            ? input.theme.textMuted
            : input.theme.text,
      );
      const descriptionColor = createMemo(() =>
        selected() ? input.theme.selectionText : input.theme.textMuted,
      );
      return (
        <box
          width="100%"
          height={rowHeight()}
          flexDirection="row"
          backgroundColor={selected() ? input.theme.primary : undefined}
          paddingLeft={DIALOG_HORIZONTAL_PADDING - markerWidth()}
          paddingRight={DIALOG_HORIZONTAL_PADDING}
          flexShrink={0}
          gap={2}
        >
          <Show when={markerWidth() > 0}>
            <box width={markerWidth()} height={rowHeight()} flexShrink={0}>
              <text
                fg={selected() ? input.theme.selectionText : input.theme.primary}
                wrapMode="none"
              >
                {padToWidth(item.marker ?? "", markerWidth())}
              </text>
              <For each={descriptionLines().slice(1)}>
                {() => <text wrapMode="none">{padToWidth("", markerWidth())}</text>}
              </For>
            </box>
          </Show>
          <box width={skillsNameColumnWidth()} height={rowHeight()} flexShrink={0}>
            <text
              fg={rowTextColor()}
              attributes={selected() ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {truncateDialogText(item.label, skillsNameColumnWidth())}
            </text>
            <For each={descriptionLines().slice(1)}>
              {() => <text wrapMode="none">{padToWidth("", skillsNameColumnWidth())}</text>}
            </For>
          </box>
          <box flexGrow={1} height={rowHeight()} flexDirection="column">
            <For each={descriptionLines()}>
              {(line) => (
                <text fg={descriptionColor()} wrapMode="none">
                  {line}
                </text>
              )}
            </For>
          </box>
        </box>
      );
    }
    const detail = createMemo(() =>
      input.variant !== "palette" && input.variant !== "skills" && item.detail
        ? truncateDialogText(item.detail, Math.min(24, Math.floor(contentWidth() / 3)))
        : undefined,
    );
    const footer = createMemo(() => {
      const footerText = input.variant === "skills" ? item.detail : item.footer;
      if (!footerText) {
        return undefined;
      }
      const defaultMaxWidth = Math.min(18, Math.floor(contentWidth() / 4));
      const maxWidth =
        input.variant === "palette"
          ? Math.max(1, contentWidth() - DIALOG_HORIZONTAL_PADDING * 2 - 1)
          : input.variant === "skills"
            ? Math.max(12, Math.floor(contentWidth() * 0.58))
            : defaultMaxWidth;
      return truncateDialogText(footerText, maxWidth);
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
  const shellContext = useShellRenderContext();
  let scrollbox: OpenTuiScrollBoxHandle | undefined;
  let previousResetKey: string | undefined;
  const rows = createMemo(() => buildPickerRenderRows(input.items));
  const contentWidth = createMemo(() => Math.max(1, input.width));
  const skillsNameColumnWidth = createMemo(() =>
    input.variant === "skills" ? resolveSkillsNameColumnWidth(rows(), contentWidth()) : 0,
  );
  const rowHeightFor = (row: PickerRenderRow) =>
    pickerRenderRowHeight(row, {
      variant: input.variant,
      contentWidth: contentWidth(),
      skillsNameColumnWidth: skillsNameColumnWidth(),
    });
  const visualRowCount = createMemo(() =>
    rows().reduce((count, row) => count + rowHeightFor(row), 0),
  );
  const viewportRows = createMemo(() =>
    input.variant === "skills"
      ? resolveSkillsPickerRows(input.height, visualRowCount(), input.topInset)
      : resolveHighDensityPickerRows(input.height, visualRowCount(), input.topInset),
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
    const selectedRange = findPickerItemVisualRange(rows(), input.selectedIndex, rowHeightFor);
    if (selectedRange === undefined) {
      node.scrollTo(0);
      return;
    }
    const viewportHeight = Math.max(1, node.viewport.height || viewportRows());
    const scrollBottom = node.scrollTop + viewportHeight;
    if (selectedRange.top < node.scrollTop) {
      node.scrollBy(selectedRange.top - node.scrollTop);
      return;
    }
    if (selectedRange.top + selectedRange.height > scrollBottom) {
      node.scrollBy(selectedRange.top + selectedRange.height - scrollBottom);
    }
  });
  return (
    <scrollbox
      id={input.id}
      ref={(node: OpenTuiScrollBoxHandle) => {
        scrollbox = node;
      }}
      width={input.width}
      height={viewportRows()}
      scrollbarOptions={{ visible: false }}
      scrollAcceleration={shellContext.scrollAcceleration()}
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
          <text fg={input.theme.textMuted}>{input.payload.footer}</text>
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

export function SkillsOverlay(input: {
  payload: CliSkillsOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const listWidth = createMemo(() => resolveDialogWidth(input.width, "large"));
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
        <box paddingTop={1} flexDirection="column">
          <text fg={input.theme.textMuted}>Search: {input.payload.query}</text>
          <text fg={input.theme.textMuted}>{input.payload.summary}</text>
        </box>
      }
      footer={
        <box paddingLeft={DIALOG_HORIZONTAL_PADDING} paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <text fg={input.theme.textMuted}>Enter insert · Ctrl+N/Ctrl+P move · Esc close</text>
        </box>
      }
    >
      <Show
        when={input.payload.items.length > 0}
        fallback={
          <box paddingLeft={DIALOG_HORIZONTAL_PADDING} paddingRight={DIALOG_HORIZONTAL_PADDING}>
            <text fg={input.theme.textMuted}>
              {input.payload.emptyMessage ?? "No skills are loaded."}
            </text>
          </box>
        }
      >
        <PickerList
          id="skills-picker-scrollbox"
          items={input.payload.items}
          selectedIndex={input.payload.selectedIndex}
          theme={input.theme}
          width={listWidth()}
          height={input.height}
          topInset={topInset()}
          variant="skills"
          resetKey={input.payload.query}
        />
      </Show>
    </DialogSelectFrame>
  );
}

function wrapOverlayLine(line: string, width: number): string[] {
  if (line.length === 0) {
    return [""];
  }
  const indent = /^\s*/u.exec(line)?.[0] ?? "";
  const body = line.slice(indent.length);
  const bodyWidth = Math.max(1, width - visibleWidth(indent));
  return wrapTextToLines(body, bodyWidth).map((wrapped) => `${indent}${wrapped}`);
}

function wrapOverlayLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => wrapOverlayLine(line, width));
}

function TextLinesOverlay(input: {
  payload:
    | CliAuthorityOverlayPayload
    | CliContextOverlayPayload
    | CliHelpHubOverlayPayload
    | CliShortcutOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const surface = createMemo(() => resolveDialogSurfaceDimensions(input.width, input.height));
  const contentWidth = createMemo(() =>
    Math.max(1, resolveDialogContentWidth(input.width, "large") - 1),
  );
  const renderedLines = createMemo(() => wrapOverlayLines(input.payload.lines, contentWidth()));
  const lineWindow = createMemo(() =>
    visibleLineWindow(renderedLines(), 0, surface().contentHeight),
  );
  const title = createMemo(() => {
    switch (input.payload.kind) {
      case "authority":
        return "Authority";
      case "context":
        return "Context";
      case "helpHub":
      case "shortcutOverlay":
        return input.payload.title;
      default:
        input.payload satisfies never;
        return "";
    }
  });
  const footer = createMemo(() =>
    input.payload.kind === "helpHub" || input.payload.kind === "shortcutOverlay"
      ? input.payload.footer
      : undefined,
  );
  return (
    <OverlaySurface
      title={title()}
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer={footer()}
    >
      <TextLineBlock lines={lineWindow().visibleLines} color={input.theme.text} />
    </OverlaySurface>
  );
}

export const AuthorityOverlay = TextLinesOverlay;
export const ContextOverlay = TextLinesOverlay;
export const HelpHubOverlay = TextLinesOverlay;
export const ShortcutOverlay = TextLinesOverlay;
