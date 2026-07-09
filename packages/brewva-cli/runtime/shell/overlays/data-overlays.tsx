/** @jsxImportSource @opentui/solid */

import { For, Match, Show, Switch, createEffect, createMemo } from "solid-js";
import { visibleWidth } from "../../../src/internal/tui/index.js";
import type {
  CliCockpitArchiveOverlayPayload,
  CliCockpitAttentionOverlayPayload,
  CliInboxOverlayPayload,
  CliInspectOverlayPayload,
  CliLineageOverlayPayload,
  CliNotificationsOverlayPayload,
  CliPagerOverlayPayload,
  CliQueueOverlayPayload,
  CliSessionsOverlayPayload,
  CliTasksOverlayPayload,
  CliTreeOverlayPayload,
  CliWorldChipStatus,
  CliWorldsDiffFile,
  CliWorldsDiffView,
  CliWorldsForkLane,
  CliWorldsForkOutcome,
  CliWorldsOverlayPayload,
} from "../../../src/shell/domain/overlays/payloads.js";
import {
  WORLD_CHIP_GLYPH,
  WORLD_LINEAGE_GLYPH,
  worldLineageKey,
} from "../../../src/shell/domain/overlays/payloads.js";
import { buildNotificationDetailLines } from "../../../src/shell/domain/overlays/projectors/notifications.js";
import {
  buildQueuePromptDetailLines,
  renderQueuePromptSummary,
} from "../../../src/shell/domain/overlays/projectors/queue.js";
import { buildSessionsOverlayRows } from "../../../src/shell/domain/overlays/projectors/sessions.js";
import {
  TASKS_OVERLAY_FOOTER_TEXT,
  buildTaskRunListLabel,
  buildTaskRunPreviewLines,
} from "../../../src/shell/domain/task-overlay-preview.js";
import type { OpenTuiScrollBoxHandle } from "../../internal-opentui-runtime.js";
import { TextAttributes } from "../../opentui/index.js";
import {
  DIALOG_FOOTER_RIGHT_PADDING,
  DIALOG_HORIZONTAL_PADDING,
  resolveHighDensityPickerRows,
  resolveDialogSelectRows,
  resolveDialogSurfaceDimensions,
  resolveDialogWidth,
  resolveHighDensityPickerTopInset,
  resolveOverlaySurfaceSelectionRows,
} from "../overlay-style.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "../palette.js";
import { useShellRenderContext } from "../render-context.js";
import { TextLineBlock } from "../transcript.js";
import { visibleLineWindow, windowSelection } from "../utils.js";
import {
  DialogFrame,
  DialogHeader,
  DialogSelectFrame,
  OverlaySurface,
  SelectionList,
  truncateDialogText,
} from "./frame.js";

export function PagerOverlay(input: {
  payload: CliPagerOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const surface = createMemo(() => resolveDialogSurfaceDimensions(input.width, input.height));
  const lineWindow = createMemo(() =>
    visibleLineWindow(input.payload.lines, input.payload.scrollOffset, surface().contentHeight),
  );
  return (
    <OverlaySurface
      title={input.payload.title ?? "Pager"}
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer={`lines ${lineWindow().start}-${lineWindow().end} of ${input.payload.lines.length} · Esc close/back · Ctrl+E external`}
    >
      <TextLineBlock lines={lineWindow().visibleLines} color={input.theme.text} />
    </OverlaySurface>
  );
}

export function InspectOverlay(input: {
  payload: CliInspectOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const surface = createMemo(() => resolveDialogSurfaceDimensions(input.width, input.height));
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(
      input.width,
      input.height,
      input.payload.sections.length,
      "large",
    ),
  );
  const section = createMemo(() => input.payload.sections[input.payload.selectedIndex]);
  const lines = createMemo(() => section()?.lines ?? []);
  const lineWindow = createMemo(() =>
    visibleLineWindow(
      lines(),
      input.payload.scrollOffsets[input.payload.selectedIndex] ?? 0,
      Math.max(4, surface().contentHeight - 2),
    ),
  );
  return (
    <OverlaySurface
      title="Inspect"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter open details · PgUp/PgDn scroll · Esc close/back"
      splitContent
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={28} flexShrink={0}>
          <SelectionList
            items={input.payload.sections.map((item) => item.title)}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            maxVisible={sidebarRows()}
          />
        </box>
        <box flexGrow={1} flexDirection="column" paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <Show when={section()}>
            {(entry) => <text fg={input.theme.textMuted}>{entry().title}</text>}
          </Show>
          <box marginTop={1} flexGrow={1}>
            <TextLineBlock lines={lineWindow().visibleLines} color={input.theme.text} />
          </box>
        </box>
      </box>
    </OverlaySurface>
  );
}

export function CockpitArchiveOverlay(input: {
  payload: CliCockpitArchiveOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const surface = createMemo(() => resolveDialogSurfaceDimensions(input.width, input.height));
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(input.width, input.height, input.payload.items.length),
  );
  const item = createMemo(() => input.payload.items[input.payload.selectedIndex]);
  const detailLines = createMemo(() => item()?.detailLines ?? ["No cockpit archive items."]);
  const detailWindow = createMemo(() =>
    visibleLineWindow(
      detailLines(),
      input.payload.scrollOffsets[input.payload.selectedIndex] ?? 0,
      Math.max(4, surface().contentHeight - 2),
    ),
  );
  return (
    <OverlaySurface
      title={input.payload.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter open detail · PgUp/PgDn scroll · Esc close/back"
      splitContent
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={32} flexShrink={0}>
          <SelectionList
            items={input.payload.items.map((entry) => entry.label)}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            maxVisible={sidebarRows()}
          />
        </box>
        <box flexGrow={1} flexDirection="column" paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <Show when={item()}>
            {(entry) => (
              <>
                <text fg={input.theme.textMuted} wrapMode="none">
                  {entry().kind} · {entry().ref}
                </text>
                <box marginTop={1} flexGrow={1}>
                  <TextLineBlock lines={detailWindow().visibleLines} color={input.theme.text} />
                </box>
              </>
            )}
          </Show>
        </box>
      </box>
    </OverlaySurface>
  );
}

export function CockpitAttentionOverlay(input: {
  payload: CliCockpitAttentionOverlayPayload;
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
      footer={`session ${input.payload.sessionId} · Esc close/back`}
    >
      <TextLineBlock lines={lineWindow().visibleLines} color={input.theme.text} />
    </OverlaySurface>
  );
}

export function NotificationsOverlay(input: {
  payload: CliNotificationsOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const notification = createMemo(() => input.payload.notifications[input.payload.selectedIndex]);
  const dialogWidth = createMemo(() => resolveDialogWidth(input.width, "large"));
  const listWidth = createMemo(() => Math.max(1, Math.min(40, Math.floor(dialogWidth() * 0.46))));
  const detailLines = createMemo(() => {
    const entry = notification();
    if (!entry) {
      return [];
    }
    return [
      `id: ${entry.id}`,
      `level: ${entry.level}`,
      `createdAt: ${new Date(entry.createdAt).toISOString()}`,
      "",
      ...entry.message.split(/\r?\n/u),
    ];
  });
  const visibleRows = createMemo(() =>
    resolveDialogSelectRows(input.height, input.payload.notifications.length),
  );
  const notificationWindow = createMemo(() =>
    windowSelection(input.payload.notifications, input.payload.selectedIndex, visibleRows()),
  );
  const detailWindow = createMemo(() =>
    visibleLineWindow(detailLines(), 0, Math.max(4, visibleRows() + 2)),
  );
  return (
    <DialogFrame width={input.width} height={input.height} theme={input.theme} size="large">
      <box gap={1} paddingBottom={1}>
        <box paddingLeft={DIALOG_HORIZONTAL_PADDING} paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <DialogHeader title="Notifications" theme={input.theme} />
        </box>
        <Show
          when={input.payload.notifications.length > 0}
          fallback={
            <box
              paddingLeft={DIALOG_HORIZONTAL_PADDING}
              paddingRight={DIALOG_HORIZONTAL_PADDING}
              paddingTop={1}
            >
              <text fg={input.theme.textMuted}>No notifications.</text>
            </box>
          }
        >
          <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
            <box width={listWidth()} flexShrink={0} flexDirection="column">
              <For each={notificationWindow().items}>
                {(entry, index) => {
                  const absoluteIndex = createMemo(() => notificationWindow().startIndex + index());
                  const selected = createMemo(
                    () => absoluteIndex() === input.payload.selectedIndex,
                  );
                  const message = createMemo(() => entry.message.split(/\r?\n/u)[0] ?? "");
                  return (
                    <box
                      flexDirection="row"
                      backgroundColor={selected() ? input.theme.primary : undefined}
                      paddingLeft={3}
                      paddingRight={3}
                      gap={1}
                    >
                      <text
                        flexGrow={1}
                        fg={selected() ? input.theme.selectionText : input.theme.text}
                        attributes={selected() ? TextAttributes.BOLD : undefined}
                        overflow="hidden"
                        wrapMode="none"
                      >
                        {truncateDialogText(message(), Math.max(8, listWidth() - 14))}
                      </text>
                      <text
                        flexShrink={0}
                        fg={selected() ? input.theme.selectionText : input.theme.textMuted}
                      >
                        {entry.level}
                      </text>
                    </box>
                  );
                }}
              </For>
            </box>
            <box
              width={1}
              flexShrink={0}
              border={["left"]}
              customBorderChars={SPLIT_BORDER_CHARS}
              borderColor={input.theme.borderSubtle}
            />
            <box flexGrow={1} flexDirection="column" paddingRight={3}>
              <Show when={notification()}>
                {(entry) => (
                  <>
                    <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
                      <text fg={input.theme.text} attributes={TextAttributes.BOLD}>
                        Details
                      </text>
                      <text
                        fg={
                          entry().level === "error"
                            ? input.theme.error
                            : entry().level === "warning"
                              ? input.theme.warning
                              : input.theme.textMuted
                        }
                      >
                        {entry().level}
                      </text>
                    </box>
                    <TextLineBlock lines={detailWindow().visibleLines} color={input.theme.text} />
                  </>
                )}
              </Show>
            </box>
          </box>
        </Show>
        <box
          paddingRight={DIALOG_FOOTER_RIGHT_PADDING}
          paddingLeft={DIALOG_HORIZONTAL_PADDING}
          flexDirection="row"
          justifyContent="space-between"
          flexShrink={0}
          paddingTop={1}
        >
          <box flexDirection="row" gap={2}>
            <text>
              <span style={{ fg: input.theme.text }}>
                <b>dismiss</b>{" "}
              </span>
              <span style={{ fg: input.theme.textMuted }}>d</span>
            </text>
            <text>
              <span style={{ fg: input.theme.text }}>
                <b>clear</b>{" "}
              </span>
              <span style={{ fg: input.theme.textMuted }}>x</span>
            </text>
          </box>
          <Show when={input.payload.notifications.length > 0}>
            <box flexDirection="row" gap={2}>
              <text>
                <span style={{ fg: input.theme.text }}>
                  <b>details</b>{" "}
                </span>
                <span style={{ fg: input.theme.textMuted }}>enter</span>
              </text>
            </box>
          </Show>
        </box>
      </box>
    </DialogFrame>
  );
}

export function InboxOverlay(input: {
  payload: CliInboxOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const surface = createMemo(() => resolveDialogSurfaceDimensions(input.width, input.height));
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(input.width, input.height, input.payload.items.length),
  );
  const item = createMemo(() => input.payload.items[input.payload.selectedIndex]);
  const questionCount = createMemo(
    () => input.payload.items.filter((entry) => entry.kind === "question").length,
  );
  const headerLines = createMemo(() => [
    `Pending questions: ${questionCount()}`,
    `Notifications: ${input.payload.notifications.length}`,
    "",
  ]);
  const detailLines = createMemo(() => {
    const entry = item();
    if (!entry) {
      return ["No pending inbox items."];
    }
    if (entry.kind === "question") {
      return ["kind: question", `source: ${entry.sourceLabel}`, "", entry.summary];
    }
    const notification = input.payload.notifications.find(
      (candidate) => candidate.id === entry.notificationId,
    );
    if (!notification) {
      return [`[${entry.level}] ${entry.summary}`];
    }
    return buildNotificationDetailLines(notification);
  });
  // The detail pane must stay inside the overlay: clip to the height left after
  // the header lines (reserving a row for the scroll hint) and scroll it with
  // PgUp/PgDn (Enter opens the full, always-scrollable pager).
  const detailWindow = createMemo(() =>
    visibleLineWindow(
      detailLines(),
      input.payload.detailScrollOffset,
      Math.max(3, surface().contentHeight - headerLines().length - 2),
    ),
  );
  const scrollHint = createMemo(() => {
    const total = detailLines().length;
    const window = detailWindow();
    if (window.visibleLines.length >= total) {
      return undefined;
    }
    return `lines ${window.start}-${window.end} of ${total} · PgUp/PgDn`;
  });
  return (
    <OverlaySurface
      title="Inbox"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter inspect · PgUp/PgDn scroll · d dismiss · x clear · Esc close"
      splitContent
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={34} flexShrink={0}>
          <Show
            when={input.payload.items.length > 0}
            fallback={<text fg={input.theme.textMuted}>No pending inbox items.</text>}
          >
            <SelectionList
              items={input.payload.items.map((entry) =>
                entry.kind === "question"
                  ? `question · ${entry.sourceLabel}`
                  : `${entry.level} · ${entry.summary.split(/\r?\n/u)[0] ?? ""}`,
              )}
              selectedIndex={input.payload.selectedIndex}
              theme={input.theme}
              maxVisible={sidebarRows()}
            />
          </Show>
        </box>
        <box flexGrow={1} flexDirection="column" paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <TextLineBlock lines={headerLines()} color={input.theme.text} />
          <box flexGrow={1}>
            <TextLineBlock lines={detailWindow().visibleLines} color={input.theme.text} />
          </box>
          <Show when={scrollHint()}>
            {(hint) => (
              <text fg={input.theme.textMuted} wrapMode="none">
                {hint()}
              </text>
            )}
          </Show>
        </box>
      </box>
    </OverlaySurface>
  );
}

const SIDEBAR_MARKER_WIDTH = 2;
type SessionRenderRow = ReturnType<typeof buildSessionsOverlayRows>[number];

function sessionRenderRowHeight(row: SessionRenderRow, index: number): number {
  return row.kind === "group" && index > 0 ? 2 : 1;
}

function sessionRenderRowsHeight(rows: readonly SessionRenderRow[]): number {
  return rows.reduce((height, row, index) => height + sessionRenderRowHeight(row, index), 0);
}

function findSessionVisualRowIndex(
  rows: readonly SessionRenderRow[],
  selectedSessionIndex: number,
): number {
  let visualIndex = 0;
  for (const [index, row] of rows.entries()) {
    if (row.kind === "group" && index > 0) {
      visualIndex += 1;
    }
    if (row.kind === "session" && row.sessionIndex === selectedSessionIndex) {
      return visualIndex;
    }
    visualIndex += 1;
  }
  return 0;
}

/** Current session ● in its own column so selection inversion does not recolor it. */
function SessionsList(input: {
  payload: CliSessionsOverlayPayload;
  theme: SessionPalette;
  listWidth: number;
  height: number;
  topInset: number;
}) {
  const shellContext = useShellRenderContext();
  let scrollbox: OpenTuiScrollBoxHandle | undefined;
  let previousResetKey: string | undefined;
  const rows = createMemo(() => buildSessionsOverlayRows(input.payload.sessions));
  const selectedVisualRowIndex = createMemo(() =>
    findSessionVisualRowIndex(rows(), input.payload.selectedIndex),
  );
  const viewportRows = createMemo(() =>
    resolveHighDensityPickerRows(input.height, sessionRenderRowsHeight(rows()), input.topInset),
  );
  const labelMaxWidth = createMemo(() =>
    Math.max(4, input.listWidth - DIALOG_HORIZONTAL_PADDING * 2 - 1),
  );
  createEffect(() => {
    const node = scrollbox;
    if (!node || node.isDestroyed) {
      return;
    }
    const resetKey = input.payload.query;
    if (resetKey !== previousResetKey) {
      previousResetKey = resetKey;
      node.scrollTo(0);
    }
    const selectedRow = selectedVisualRowIndex();
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
      id="sessions-scrollbox"
      ref={(node: OpenTuiScrollBoxHandle) => {
        scrollbox = node;
      }}
      width="100%"
      height={viewportRows()}
      scrollbarOptions={{ visible: false }}
      scrollAcceleration={shellContext.scrollAcceleration()}
    >
      <For each={rows()}>
        {(row, index) => {
          if (row.kind === "group") {
            return (
              <box
                width="100%"
                paddingTop={index() === 0 ? 0 : 1}
                paddingLeft={DIALOG_HORIZONTAL_PADDING}
                paddingRight={DIALOG_HORIZONTAL_PADDING}
                flexShrink={0}
              >
                <text
                  fg={input.theme.accent}
                  attributes={TextAttributes.BOLD}
                  overflow="hidden"
                  wrapMode="none"
                >
                  {truncateDialogText(row.label, labelMaxWidth())}
                </text>
              </box>
            );
          }
          const item = row.session;
          const selected = createMemo(() => row.sessionIndex === input.payload.selectedIndex);
          const isCurrent = createMemo(() => item.sessionId === input.payload.currentSessionId);
          const markerFg = createMemo(() =>
            selected()
              ? input.theme.selectionText
              : isCurrent()
                ? input.theme.primary
                : input.theme.textMuted,
          );
          const label = createMemo(() => {
            const draft = input.payload.draftStateBySessionId[item.sessionId];
            const title = item.title ?? "Untitled session";
            const body = draft ? `${title} · draft ${draft.characters} chars` : title;
            return truncateDialogText(body, labelMaxWidth());
          });
          return (
            <box
              width="100%"
              flexDirection="row"
              alignItems="center"
              backgroundColor={selected() ? input.theme.primary : undefined}
              paddingLeft={DIALOG_HORIZONTAL_PADDING - SIDEBAR_MARKER_WIDTH}
              paddingRight={DIALOG_HORIZONTAL_PADDING}
              flexShrink={0}
              gap={0}
            >
              {/*
                Fixed-width marker column. Marker text is padded to exactly
                SIDEBAR_MARKER_WIDTH visible cells so opentui's
                visibleWidth (●=1, space=1) cannot shift the label column
                across rows. Box width also reserves the column at the
                flex-layout level as a belt-and-suspenders.
              */}
              <box width={SIDEBAR_MARKER_WIDTH} flexShrink={0}>
                <text
                  fg={markerFg()}
                  wrapMode="none"
                  attributes={isCurrent() ? TextAttributes.BOLD : undefined}
                >
                  {isCurrent() ? "● " : "  "}
                </text>
              </box>
              <text
                flexGrow={1}
                fg={selected() ? input.theme.selectionText : input.theme.text}
                attributes={selected() ? TextAttributes.BOLD : undefined}
                overflow="hidden"
                wrapMode="none"
              >
                {label()}
              </text>
            </box>
          );
        }}
      </For>
    </scrollbox>
  );
}

/** Current lineage ● mirrors the sessions sidebar marker column and selection treatment. */
function LineageSidebarList(input: {
  payload: CliLineageOverlayPayload;
  theme: SessionPalette;
  sidebarWidth: number;
  maxVisible: number;
}) {
  const selectionWindow = createMemo(() =>
    windowSelection(input.payload.nodes, input.payload.selectedIndex, input.maxVisible),
  );
  const labelMaxWidth = createMemo(() =>
    Math.max(4, input.sidebarWidth - DIALOG_HORIZONTAL_PADDING * 2 - 1),
  );
  return (
    <box width="100%" flexDirection="column" backgroundColor={input.theme.backgroundPanel}>
      <For each={selectionWindow().items}>
        {(item, index) => {
          const absoluteIndex = createMemo(() => selectionWindow().startIndex + index());
          const selected = createMemo(() => absoluteIndex() === input.payload.selectedIndex);
          const markerFg = createMemo(() =>
            selected()
              ? input.theme.selectionText
              : item.current
                ? input.theme.primary
                : input.theme.textMuted,
          );
          const label = createMemo(() => {
            const title = item.title ?? item.kind;
            const indent = "  ".repeat(item.depth);
            return truncateDialogText(`${indent}${title}`, labelMaxWidth());
          });
          return (
            <box
              width="100%"
              flexDirection="row"
              alignItems="center"
              backgroundColor={selected() ? input.theme.primary : undefined}
              paddingLeft={DIALOG_HORIZONTAL_PADDING - SIDEBAR_MARKER_WIDTH}
              paddingRight={DIALOG_HORIZONTAL_PADDING}
              flexShrink={0}
              gap={0}
            >
              <box width={SIDEBAR_MARKER_WIDTH} flexShrink={0}>
                <text
                  fg={markerFg()}
                  wrapMode="none"
                  attributes={item.current ? TextAttributes.BOLD : undefined}
                >
                  {item.current ? "● " : "  "}
                </text>
              </box>
              <text
                flexGrow={1}
                fg={selected() ? input.theme.selectionText : input.theme.text}
                attributes={selected() ? TextAttributes.BOLD : undefined}
                overflow="hidden"
                wrapMode="none"
              >
                {label()}
              </text>
            </box>
          );
        }}
      </For>
    </box>
  );
}

function TreeSidebarList(input: {
  payload: CliTreeOverlayPayload;
  theme: SessionPalette;
  sidebarWidth: number;
  maxVisible: number;
}) {
  const selectionWindow = createMemo(() =>
    windowSelection(input.payload.nodes, input.payload.selectedIndex, input.maxVisible),
  );
  const labelMaxWidth = createMemo(() =>
    Math.max(4, input.sidebarWidth - DIALOG_HORIZONTAL_PADDING * 2 - SIDEBAR_MARKER_WIDTH),
  );
  return (
    <box width="100%" flexDirection="column" backgroundColor={input.theme.backgroundPanel}>
      <For each={selectionWindow().items}>
        {(item, index) => {
          const absoluteIndex = createMemo(() => selectionWindow().startIndex + index());
          const selected = createMemo(() => absoluteIndex() === input.payload.selectedIndex);
          const markerFg = createMemo(() =>
            selected()
              ? input.theme.selectionText
              : item.current
                ? input.theme.primary
                : item.activePath
                  ? input.theme.text
                  : input.theme.textMuted,
          );
          const label = createMemo(() => {
            const indent = "  ".repeat(item.depth);
            return truncateDialogText(`${indent}${item.preview}`, labelMaxWidth());
          });
          const marker = createMemo(() => {
            if (item.current) {
              return "● ";
            }
            if (item.activePath) {
              return "│ ";
            }
            if (item.childCount > 0) {
              return item.collapsed ? "+ " : "- ";
            }
            return "  ";
          });
          return (
            <box
              width="100%"
              flexDirection="row"
              alignItems="center"
              backgroundColor={selected() ? input.theme.primary : undefined}
              paddingLeft={DIALOG_HORIZONTAL_PADDING - SIDEBAR_MARKER_WIDTH}
              paddingRight={DIALOG_HORIZONTAL_PADDING}
              flexShrink={0}
              gap={0}
            >
              <box width={SIDEBAR_MARKER_WIDTH} flexShrink={0}>
                <text
                  fg={markerFg()}
                  wrapMode="none"
                  attributes={item.current ? TextAttributes.BOLD : undefined}
                >
                  {marker()}
                </text>
              </box>
              <text
                flexGrow={1}
                fg={selected() ? input.theme.selectionText : input.theme.text}
                attributes={selected() ? TextAttributes.BOLD : undefined}
                overflow="hidden"
                wrapMode="none"
              >
                {label()}
              </text>
            </box>
          );
        }}
      </For>
    </box>
  );
}

export function SessionsOverlay(input: {
  payload: CliSessionsOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const topInset = createMemo(() => resolveHighDensityPickerTopInset(input.height));
  return (
    <DialogSelectFrame
      title="Sessions"
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
          <text fg={input.theme.textMuted}>Enter switch · Esc close · type to search</text>
        </box>
      }
    >
      <box flexGrow={1} flexDirection="column">
        <Show
          when={input.payload.sessions.length > 0}
          fallback={
            <box paddingLeft={DIALOG_HORIZONTAL_PADDING} paddingRight={DIALOG_HORIZONTAL_PADDING}>
              <text fg={input.theme.textMuted}>
                {input.payload.query.trim() ? "No matching sessions." : "No sessions found."}
              </text>
            </box>
          }
        >
          <SessionsList
            payload={input.payload}
            theme={input.theme}
            listWidth={resolveDialogWidth(input.width, "large")}
            height={input.height}
            topInset={topInset()}
          />
        </Show>
      </box>
    </DialogSelectFrame>
  );
}

export function TreeOverlay(input: {
  payload: CliTreeOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const node = createMemo(() => input.payload.nodes[input.payload.selectedIndex]);
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(input.width, input.height, input.payload.nodes.length),
  );
  const sidebarWidth = 40;
  const detailLines = createMemo(() => {
    const entry = node();
    if (!entry) {
      return ["No context entries found."];
    }
    return [
      `id: ${entry.entryId}`,
      `parent: ${entry.parentEntryId ?? "none"}`,
      `lineage: ${entry.lineageNodeId}`,
      `kind: ${entry.entryKind}`,
      `role: ${entry.role ?? "n/a"}`,
      `presentTo: ${entry.presentTo}`,
      `admission: ${entry.admission}`,
      `source: ${entry.sourceEventType}`,
      `current: ${entry.current ? "yes" : "no"}`,
      `active path: ${entry.activePath ? "yes" : "no"}`,
      `children: ${entry.childCount}`,
      `workspace effects after this entry: ${entry.workspaceEffectPatchSetCount} patch set(s)`,
      `prompt restore: ${entry.restorablePromptText === null ? "no" : "literal text"}`,
      `preview: ${entry.preview}`,
    ];
  });
  const footer = createMemo(() => {
    const search = input.payload.query.trim() ? ` · search ${input.payload.query.trim()}` : "";
    return `Enter checkout · / search · F filter ${input.payload.filter} · c quick carry · f fold · l lineage · r rewind · Esc close${search}`;
  });
  return (
    <OverlaySurface
      title="Tree"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer={footer()}
      splitContent
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={sidebarWidth} flexShrink={0}>
          <Show
            when={input.payload.nodes.length > 0}
            fallback={<text fg={input.theme.textMuted}>No context entries found.</text>}
          >
            <TreeSidebarList
              payload={input.payload}
              theme={input.theme}
              sidebarWidth={sidebarWidth}
              maxVisible={sidebarRows()}
            />
          </Show>
        </box>
        <box flexGrow={1} flexDirection="column" paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <TextLineBlock lines={detailLines()} color={input.theme.text} />
        </box>
      </box>
    </OverlaySurface>
  );
}

export function LineageOverlay(input: {
  payload: CliLineageOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const node = createMemo(() => input.payload.nodes[input.payload.selectedIndex]);
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(input.width, input.height, input.payload.nodes.length),
  );
  const sidebarWidth = 34;
  const detailLines = createMemo(() => {
    const entry = node();
    if (!entry) {
      return ["No lineage nodes found."];
    }
    return [
      `id: ${entry.lineageNodeId}`,
      `kind: ${entry.kind}`,
      `title: ${entry.title ?? "n/a"}`,
      `parent: ${entry.parentLineageNodeId ?? "none"}`,
      `forkPoint: ${entry.forkPoint}`,
      `leaf: ${entry.leafEntryId ?? "root"}`,
      `current: ${entry.current ? "yes" : "no"}`,
      `children: ${entry.childCount}`,
      `summaries: ${entry.summaryCount}`,
      `outcomes: ${entry.outcomeCount}`,
      `adopted outcomes: ${entry.adoptedOutcomeCount}`,
    ];
  });
  return (
    <OverlaySurface
      title="Lineage"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter checkout · t scoped tree · Esc close"
      splitContent
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={sidebarWidth} flexShrink={0}>
          <Show
            when={input.payload.nodes.length > 0}
            fallback={<text fg={input.theme.textMuted}>No lineage nodes found.</text>}
          >
            <LineageSidebarList
              payload={input.payload}
              theme={input.theme}
              sidebarWidth={sidebarWidth}
              maxVisible={sidebarRows()}
            />
          </Show>
        </box>
        <box flexGrow={1} flexDirection="column" paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <TextLineBlock lines={detailLines()} color={input.theme.text} />
        </box>
      </box>
    </OverlaySurface>
  );
}

const WORLD_CHIP_COLOR: Record<CliWorldChipStatus, "success" | "warning" | "error" | "textDim"> = {
  captured: "success",
  missing_artifacts: "warning",
  capture_failed: "error",
  not_captured: "textDim",
};

const WORLD_CHIP_WIDTH = 2;

/**
 * The `/worlds` timeline rail: one row per rewind checkpoint fusing the conversation axis
 * (lineage glyph + turn + prompt) with the environment axis (a colored world-lane chip).
 * Modeled on {@link TreeSidebarList} — a windowed, selection-inverting custom row so the
 * chip can carry its own color, which a plain string `SelectionList` cannot.
 */
function WorldsTimelineList(input: {
  payload: CliWorldsOverlayPayload;
  theme: SessionPalette;
  sidebarWidth: number;
  maxVisible: number;
}) {
  const selectionWindow = createMemo(() =>
    windowSelection(input.payload.rows, input.payload.selectedIndex, input.maxVisible),
  );
  const labelMaxWidth = createMemo(() =>
    Math.max(
      4,
      input.sidebarWidth - DIALOG_HORIZONTAL_PADDING * 2 - SIDEBAR_MARKER_WIDTH - WORLD_CHIP_WIDTH,
    ),
  );
  return (
    <box width="100%" flexDirection="column" backgroundColor={input.theme.backgroundPanel}>
      <For each={selectionWindow().items}>
        {(row, index) => {
          const absoluteIndex = createMemo(() => selectionWindow().startIndex + index());
          const selected = createMemo(() => absoluteIndex() === input.payload.selectedIndex);
          const marker = createMemo(() => `${WORLD_LINEAGE_GLYPH[worldLineageKey(row)]} `);
          const markerFg = createMemo(() =>
            selected()
              ? input.theme.selectionText
              : row.current
                ? input.theme.primary
                : row.abandoned
                  ? input.theme.textDim
                  : input.theme.text,
          );
          const chipGlyph = createMemo(() => WORLD_CHIP_GLYPH[row.worldStatus]);
          const chipColor = createMemo(() => input.theme[WORLD_CHIP_COLOR[row.worldStatus]]);
          const label = createMemo(() =>
            truncateDialogText(
              `t${row.turn}  ${row.promptPreview || "(no prompt)"}`,
              labelMaxWidth(),
            ),
          );
          return (
            <box
              width="100%"
              flexDirection="row"
              alignItems="center"
              backgroundColor={selected() ? input.theme.primary : undefined}
              paddingLeft={DIALOG_HORIZONTAL_PADDING - SIDEBAR_MARKER_WIDTH}
              paddingRight={DIALOG_HORIZONTAL_PADDING}
              flexShrink={0}
            >
              <box width={SIDEBAR_MARKER_WIDTH} flexShrink={0}>
                <text
                  fg={markerFg()}
                  wrapMode="none"
                  attributes={row.current ? TextAttributes.BOLD : undefined}
                >
                  {marker()}
                </text>
              </box>
              <text
                flexGrow={1}
                fg={selected() ? input.theme.selectionText : input.theme.text}
                attributes={selected() ? TextAttributes.BOLD : undefined}
                overflow="hidden"
                wrapMode="none"
              >
                {label()}
              </text>
              <box width={WORLD_CHIP_WIDTH} flexShrink={0} alignItems="flex-end">
                <text fg={selected() ? input.theme.selectionText : chipColor()} wrapMode="none">
                  {chipGlyph()}
                </text>
              </box>
            </box>
          );
        }}
      </For>
    </box>
  );
}

const DIFF_CHANGE: Record<
  CliWorldsDiffFile["change"],
  { readonly glyph: string; readonly token: "diffAdded" | "warning" | "diffRemoved" }
> = {
  added: { glyph: "+", token: "diffAdded" },
  modified: { glyph: "~", token: "warning" },
  deleted: { glyph: "-", token: "diffRemoved" },
};

/** The `/worlds` Diff view: the selected checkpoint's world vs the previous, file-level. */
function WorldsDiffPane(input: {
  diff: CliWorldsDiffView | null;
  worldsEnabled: boolean;
  theme: SessionPalette;
  scrollOffset: number;
  contentRows: number;
}) {
  const files = createMemo(() => input.diff?.files ?? []);
  // Reserve the header line; the rest of the pane is the scrollable file window, sized to
  // the viewport (NOT the checkpoint count) so a large changeset is fully reachable.
  const windowRows = createMemo(() => Math.max(3, input.contentRows - 2));
  const maxOffset = createMemo(() => Math.max(0, files().length - windowRows()));
  const offset = createMemo(() => Math.min(Math.max(0, input.scrollOffset), maxOffset()));
  const windowFiles = createMemo(() => files().slice(offset(), offset() + windowRows()));
  const hiddenBelow = createMemo(() => files().length - offset() - windowFiles().length);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingLeft={DIALOG_HORIZONTAL_PADDING}
      paddingRight={DIALOG_HORIZONTAL_PADDING}
    >
      <Show
        when={input.worldsEnabled}
        fallback={
          <text fg={input.theme.textMuted}>
            Worlds are disabled (config worlds.enabled) — no diff to show.
          </text>
        }
      >
        <Show
          when={input.diff}
          fallback={
            <text fg={input.theme.textMuted}>
              Select a checkpoint, then press 2 to diff its world.
            </text>
          }
        >
          {(diff) => (
            <Show
              when={diff().available}
              fallback={
                <text fg={input.theme.textMuted}>
                  No diff available — no world here, or the previous world is unavailable.
                </text>
              }
            >
              <text fg={input.theme.textMuted} wrapMode="none">
                world at turn {diff().turn} vs previous · +{diff().added} ~{diff().modified} -
                {diff().deleted}
                {offset() > 0 ? ` · scrolled ${offset()}` : ""}
              </text>
              <box marginTop={1} flexDirection="column" flexGrow={1}>
                <Show
                  when={diff().files.length > 0}
                  fallback={
                    <text fg={input.theme.textMuted}>No file changes vs the previous world.</text>
                  }
                >
                  <For each={windowFiles()}>
                    {(file) => (
                      <box flexDirection="row" flexShrink={0}>
                        <text fg={input.theme[DIFF_CHANGE[file.change].token]} wrapMode="none">
                          {`${DIFF_CHANGE[file.change].glyph} `}
                        </text>
                        <text fg={input.theme.text} overflow="hidden" wrapMode="none">
                          {file.path}
                        </text>
                      </box>
                    )}
                  </For>
                  <Show when={hiddenBelow() > 0}>
                    <text fg={input.theme.textMuted}>… {hiddenBelow()} more (PgDn)</text>
                  </Show>
                </Show>
              </box>
            </Show>
          )}
        </Show>
      </Show>
    </box>
  );
}

const FORK_OUTCOME: Record<
  CliWorldsForkOutcome,
  { readonly glyph: string; readonly token: "diffAdded" | "warning" | "error" }
> = {
  applied: { glyph: "✓", token: "diffAdded" },
  apply_failed: { glyph: "⚠", token: "warning" },
  rejected: { glyph: "✗", token: "error" },
};

/**
 * Tape-derivable settlement-reason badges (RFC View 3: no-op / parent-diverged). A plain
 * fast-forward apply carries no reason, so it shows no badge; an unknown internal reason
 * is not surfaced (the outcome glyph already conveys applied/failed/rejected).
 */
const FORK_REASON_LABEL: Record<string, string> = {
  already_applied: "no-op",
  basis_conflict: "parent diverged",
};

/** One Forks lane's single-line summary: workers · applied paths · conflicts · reason badge. */
function forkLaneSummary(lane: CliWorldsForkLane): string {
  const workers = lane.workerIds.join(", ") || "(workers)";
  const paths = `${lane.appliedPathCount} path${lane.appliedPathCount === 1 ? "" : "s"}`;
  const conflicts =
    lane.conflictPaths.length > 0
      ? ` · ⚡ ${lane.conflictPaths.length} conflict${lane.conflictPaths.length === 1 ? "" : "s"}`
      : "";
  const badge =
    lane.reason && FORK_REASON_LABEL[lane.reason] ? ` · ${FORK_REASON_LABEL[lane.reason]}` : "";
  return `${workers} · ${paths}${conflicts}${badge}`;
}

/** The `/worlds` Forks view: tape-derived delegation-changeset settlement lanes. */
function WorldsForksPane(input: {
  forks: readonly CliWorldsForkLane[];
  theme: SessionPalette;
  scrollOffset: number;
  contentRows: number;
}) {
  const windowRows = createMemo(() => Math.max(3, input.contentRows - 1));
  const maxOffset = createMemo(() => Math.max(0, input.forks.length - windowRows()));
  const offset = createMemo(() => Math.min(Math.max(0, input.scrollOffset), maxOffset()));
  const windowLanes = createMemo(() => input.forks.slice(offset(), offset() + windowRows()));
  const hiddenBelow = createMemo(() => input.forks.length - offset() - windowLanes().length);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingLeft={DIALOG_HORIZONTAL_PADDING}
      paddingRight={DIALOG_HORIZONTAL_PADDING}
    >
      <Show
        when={input.forks.length > 0}
        fallback={
          <text fg={input.theme.textMuted}>No delegation forks settled in this session.</text>
        }
      >
        <For each={windowLanes()}>
          {(lane) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={input.theme[FORK_OUTCOME[lane.outcome].token]} wrapMode="none">
                {`${FORK_OUTCOME[lane.outcome].glyph} `}
              </text>
              <text fg={input.theme.text} overflow="hidden" wrapMode="none">
                {forkLaneSummary(lane)}
              </text>
            </box>
          )}
        </For>
        <Show when={hiddenBelow() > 0}>
          <text fg={input.theme.textMuted}>… {hiddenBelow()} more (PgDn)</text>
        </Show>
      </Show>
    </box>
  );
}

/**
 * The `/worlds` operator panel (rfc-worlds-operator-panel): a timeline of rewind
 * checkpoints fused with world-lane readiness chips (Timeline view, 1), a file-level world
 * diff (Diff view, 2), tape-derived delegation settlement lanes (Forks view, 3), and
 * confirm-gated rewind (r) — the environment axis as a first-class, operable surface.
 */
export function WorldsOverlay(input: {
  payload: CliWorldsOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const row = createMemo(() => input.payload.rows[input.payload.selectedIndex]);
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(input.width, input.height, input.payload.rows.length),
  );
  const surface = createMemo(() => resolveDialogSurfaceDimensions(input.width, input.height));
  const sidebarWidth = 52;
  const detailLines = createMemo(() => {
    const entry = row();
    if (!entry) {
      return input.payload.worldsEnabled
        ? ["No rewind checkpoints captured yet."]
        : [
            "Worlds are disabled (config worlds.enabled).",
            "The timeline lists checkpoints; no world is captured for them.",
          ];
    }
    const worldLine =
      entry.worldStatus === "captured"
        ? `world: captured · ${entry.worldId ?? "—"}`
        : entry.worldStatus === "missing_artifacts"
          ? `world: material missing · ${entry.worldId ?? "—"}`
          : entry.worldStatus === "capture_failed"
            ? "world: capture failed"
            : "world: not captured";
    return [
      `checkpoint: ${entry.checkpointId}`,
      `turn: ${entry.turn}`,
      `time: ${new Date(entry.timestamp).toISOString()}`,
      `lineage: ${worldLineageKey(entry)}${entry.current ? " (HEAD)" : ""}`,
      worldLine,
      `patch sets after: ${entry.patchSetCountAfter}`,
      `prompt: ${entry.promptPreview || "(none)"}`,
    ];
  });
  const footer = createMemo(() => {
    if (input.payload.view === "diff") {
      return "PgUp/PgDn scroll · r rewind · 1 timeline · 3 forks · Esc close";
    }
    if (input.payload.view === "forks") {
      return "PgUp/PgDn scroll · 1 timeline · 2 diff · Esc close";
    }
    return input.payload.worldsEnabled
      ? "↑↓ select · 2 diff · 3 forks · r rewind · Esc close"
      : "worlds disabled · ↑↓ select · 2 diff · 3 forks · r rewind · Esc close";
  });
  return (
    <OverlaySurface
      title="Worlds"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer={footer()}
      splitContent
    >
      <Switch
        fallback={
          <box flexDirection="row" gap={1} flexGrow={1}>
            <box width={sidebarWidth} flexShrink={0}>
              <Show
                when={input.payload.rows.length > 0}
                fallback={<text fg={input.theme.textMuted}>No checkpoints yet.</text>}
              >
                <WorldsTimelineList
                  payload={input.payload}
                  theme={input.theme}
                  sidebarWidth={sidebarWidth}
                  maxVisible={sidebarRows()}
                />
              </Show>
            </box>
            <box flexGrow={1} flexDirection="column" paddingRight={DIALOG_HORIZONTAL_PADDING}>
              <TextLineBlock lines={detailLines()} color={input.theme.text} />
            </box>
          </box>
        }
      >
        <Match when={input.payload.view === "diff"}>
          <WorldsDiffPane
            diff={input.payload.diff}
            worldsEnabled={input.payload.worldsEnabled}
            theme={input.theme}
            scrollOffset={input.payload.diffScrollOffset}
            contentRows={surface().contentHeight}
          />
        </Match>
        <Match when={input.payload.view === "forks"}>
          <WorldsForksPane
            forks={input.payload.forks}
            theme={input.theme}
            scrollOffset={input.payload.forksScrollOffset}
            contentRows={surface().contentHeight}
          />
        </Match>
      </Switch>
    </OverlaySurface>
  );
}

export function QueueOverlay(input: {
  payload: CliQueueOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const queueListLabelWidth = 34 - visibleWidth("queued · ") - 1;
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(input.width, input.height, input.payload.items.length),
  );
  const item = createMemo(() => input.payload.items[input.payload.selectedIndex]);
  const detailLines = createMemo(() => {
    const entry = item();
    return entry ? buildQueuePromptDetailLines(entry) : [];
  });
  return (
    <OverlaySurface
      title="Queued prompts"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter details · d delete · Esc close"
      splitContent
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={34} flexShrink={0}>
          <SelectionList
            items={input.payload.items.map(
              (entry) => `queued · ${renderQueuePromptSummary(entry.text, queueListLabelWidth)}`,
            )}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            maxVisible={sidebarRows()}
          />
        </box>
        <box flexGrow={1} flexDirection="column" paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <Show when={item()} fallback={<text fg={input.theme.textMuted}>No queued prompts.</text>}>
            <TextLineBlock lines={detailLines()} color={input.theme.text} />
          </Show>
        </box>
      </box>
    </OverlaySurface>
  );
}

export function TasksOverlay(input: {
  payload: CliTasksOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(
      input.width,
      input.height,
      input.payload.snapshot.taskRuns.length,
    ),
  );
  const run = createMemo(() => input.payload.snapshot.taskRuns[input.payload.selectedIndex]);
  const previewLines = createMemo(() => {
    const entry = run();
    return entry ? buildTaskRunPreviewLines(entry) : [];
  });
  return (
    <OverlaySurface
      title="Tasks"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer={TASKS_OVERLAY_FOOTER_TEXT}
      splitContent
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={34} flexShrink={0}>
          <SelectionList
            items={input.payload.snapshot.taskRuns.map((item) => buildTaskRunListLabel(item))}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            maxVisible={sidebarRows()}
          />
        </box>
        <box flexGrow={1} flexDirection="column" paddingRight={DIALOG_HORIZONTAL_PADDING}>
          <Show when={run()}>
            {(entry) => (
              <TextLineBlock
                lines={[
                  `runId: ${entry().runId}`,
                  `status: ${entry().status}`,
                  ...(entry().workerSessionId
                    ? [`workerSessionId: ${entry().workerSessionId}`]
                    : []),
                  "",
                  ...previewLines(),
                ]}
                color={input.theme.text}
              />
            )}
          </Show>
        </box>
      </box>
    </OverlaySurface>
  );
}
