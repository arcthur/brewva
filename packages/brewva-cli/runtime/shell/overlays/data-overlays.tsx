/** @jsxImportSource @opentui/solid */

import { For, Show, createEffect, createMemo } from "solid-js";
import { visibleWidth } from "../../../src/internal/tui/index.js";
import type {
  CliInboxOverlayPayload,
  CliInspectOverlayPayload,
  CliLineageOverlayPayload,
  CliNotificationsOverlayPayload,
  CliPagerOverlayPayload,
  CliQueueOverlayPayload,
  CliSessionsOverlayPayload,
  CliTasksOverlayPayload,
} from "../../../src/shell/domain/overlays/payloads.js";
import { buildNotificationDetailLines } from "../../../src/shell/domain/overlays/projectors/notifications.js";
import {
  buildQueuePromptDetailLines,
  renderQueuePromptSummary,
} from "../../../src/shell/domain/overlays/projectors/queue.js";
import { buildSessionsOverlayRows } from "../../../src/shell/domain/overlays/projectors/sessions.js";
import {
  buildTaskRunListLabel,
  buildTaskRunPreviewLines,
} from "../../../src/shell/domain/task-details.js";
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
import {
  DEFAULT_SCROLL_ACCELERATION,
  SPLIT_BORDER_CHARS,
  type SessionPalette,
} from "../palette.js";
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
  const sidebarRows = createMemo(() =>
    resolveOverlaySurfaceSelectionRows(input.width, input.height, input.payload.items.length),
  );
  const item = createMemo(() => input.payload.items[input.payload.selectedIndex]);
  const questionCount = createMemo(
    () => input.payload.items.filter((entry) => entry.kind === "question").length,
  );
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
  return (
    <OverlaySurface
      title="Inbox"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter inspect · d dismiss notification · x clear notifications · Esc close"
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
          <TextLineBlock
            lines={[
              `Pending questions: ${questionCount()}`,
              `Notifications: ${input.payload.notifications.length}`,
              "",
              ...detailLines(),
            ]}
            color={input.theme.text}
          />
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
      scrollAcceleration={DEFAULT_SCROLL_ACCELERATION}
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
      footer="Enter checkout · Esc close"
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
      footer="Enter inspect output · c cancel task · Esc close"
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
