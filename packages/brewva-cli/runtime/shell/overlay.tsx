/** @jsxImportSource @opentui/solid */

import { truncateToWidth, visibleWidth } from "@brewva/brewva-tui";
import { TextAttributes } from "@opentui/core";
import { For, Match, Show, Switch, createMemo, type JSX } from "solid-js";
import type { CliShellState } from "../../src/shell/state/index.js";
import { buildTaskRunListLabel, buildTaskRunPreviewLines } from "../../src/shell/task-details.js";
import type {
  CliApprovalOverlayPayload,
  CliAuthMethodPickerOverlayPayload,
  CliCommandPaletteOverlayPayload,
  CliConfirmOverlayPayload,
  CliHelpHubOverlayPayload,
  CliInputOverlayPayload,
  CliInspectOverlayPayload,
  CliModelPickerOverlayPayload,
  CliNotificationsOverlayPayload,
  CliOAuthWaitOverlayPayload,
  CliPagerOverlayPayload,
  CliProviderPickerOverlayPayload,
  CliQuestionOverlayPayload,
  CliSelectOverlayPayload,
  CliSessionsOverlayPayload,
  CliShellOverlayPayload,
  CliThinkingPickerOverlayPayload,
  CliTasksOverlayPayload,
} from "../../src/shell/types.js";
import {
  DIALOG_BACKDROP,
  DIALOG_FOOTER_RIGHT_PADDING,
  DIALOG_HORIZONTAL_PADDING,
  DIALOG_Z_INDEX,
  type DialogSize,
  resolveDialogContentWidth,
  resolveDialogSelectRows,
  resolveDialogSurfaceDimensions,
  resolveDialogTopInset,
  resolveDialogWidth,
} from "./overlay-style.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import { TextLineBlock } from "./transcript.js";
import { visibleLineWindow, windowSelection } from "./utils.js";

function truncateDialogText(text: string, maxWidth: number): string {
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

function DialogFrame(input: {
  width: number;
  height: number;
  theme: SessionPalette;
  size?: DialogSize;
  children: JSX.Element;
}) {
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
      paddingTop={resolveDialogTopInset(input.height)}
    >
      <box
        width={resolveDialogWidth(input.width, input.size)}
        backgroundColor={input.theme.backgroundPanel}
        paddingTop={1}
      >
        {input.children}
      </box>
    </box>
  );
}

function DialogHeader(input: { title: string; theme: SessionPalette }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={input.theme.text} attributes={TextAttributes.BOLD}>
        {input.title}
      </text>
      <text fg={input.theme.textMuted}>esc</text>
    </box>
  );
}

function DialogSelectFrame(input: {
  width: number;
  height: number;
  title: string;
  theme: SessionPalette;
  size?: DialogSize;
  search?: JSX.Element;
  children: JSX.Element;
  footer?: JSX.Element;
}) {
  return (
    <DialogFrame width={input.width} height={input.height} theme={input.theme} size={input.size}>
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

function OverlaySurface(input: {
  width: number;
  height: number;
  title: string;
  theme: SessionPalette;
  size?: DialogSize;
  footer?: string;
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
          paddingLeft={DIALOG_HORIZONTAL_PADDING}
          paddingRight={DIALOG_HORIZONTAL_PADDING}
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

function SelectionList(input: {
  items: readonly string[];
  selectedIndex: number;
  theme: SessionPalette;
  maxVisible?: number;
}) {
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
              paddingLeft={3}
              paddingRight={3}
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

function PagerOverlay(input: {
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

function InspectOverlay(input: {
  payload: CliInspectOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const surface = createMemo(() => resolveDialogSurfaceDimensions(input.width, input.height));
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
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={28} flexShrink={0}>
          <SelectionList
            items={input.payload.sections.map((item) => item.title)}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            maxVisible={10}
          />
        </box>
        <box flexGrow={1} flexDirection="column">
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

function NotificationsOverlay(input: {
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

function SessionsOverlay(input: {
  payload: CliSessionsOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const session = createMemo(() => input.payload.sessions[input.payload.selectedIndex]);
  return (
    <OverlaySurface
      title="Sessions"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter switch · n new session · Esc close"
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={34} flexShrink={0}>
          <SelectionList
            items={input.payload.sessions.map((item) => {
              const draft = input.payload.draftStateBySessionId[item.sessionId];
              return draft
                ? `${item.sessionId} · draft ${draft.characters} chars`
                : `${item.sessionId} · ${item.eventCount} events`;
            })}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            maxVisible={10}
          />
        </box>
        <box flexGrow={1} flexDirection="column">
          <Show when={session()}>
            {(entry) => (
              <TextLineBlock
                lines={[
                  `session: ${entry().sessionId}`,
                  `events: ${entry().eventCount}`,
                  `lastEventAt: ${new Date(entry().lastEventAt).toISOString()}`,
                  entry().sessionId === input.payload.currentSessionId
                    ? "current: yes"
                    : "current: no",
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

function TasksOverlay(input: {
  payload: CliTasksOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
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
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={34} flexShrink={0}>
          <SelectionList
            items={input.payload.snapshot.taskRuns.map((item) => buildTaskRunListLabel(item))}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            maxVisible={10}
          />
        </box>
        <box flexGrow={1} flexDirection="column">
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

function InputOverlay(input: {
  payload: CliInputOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
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
          <text fg={input.theme.text}>
            {input.payload.masked ? "*".repeat(input.payload.value.length) : input.payload.value}
          </text>
        </box>
      </box>
    </OverlaySurface>
  );
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
            const rowChromeWidth = 6;
            const availableWidth = contentWidth() - detailWidth - footerWidth - rowChromeWidth;
            return truncateDialogText(item.label, Math.max(1, Math.min(61, availableWidth)));
          });
          return (
            <>
              <Show when={showSection()}>
                <box paddingTop={absoluteIndex() === 0 ? 0 : 1} paddingLeft={3} flexShrink={0}>
                  <text fg={input.theme.accent} attributes={TextAttributes.BOLD}>
                    {item.section}
                  </text>
                </box>
              </Show>
              <box
                width="100%"
                flexDirection="row"
                backgroundColor={selected() ? input.theme.primary : undefined}
                paddingLeft={item.marker ? 1 : 3}
                paddingRight={3}
                flexShrink={0}
                gap={1}
              >
                <Show when={item.marker}>
                  <text
                    fg={
                      selected()
                        ? input.theme.selectionText
                        : item.disabled
                          ? input.theme.textMuted
                          : input.theme.primary
                    }
                    flexShrink={0}
                    wrapMode="none"
                  >
                    {item.marker}
                  </text>
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
            </>
          );
        }}
      </For>
    </box>
  );
}

function ModelPickerOverlay(input: {
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

function ProviderPickerOverlay(input: {
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

function ThinkingPickerOverlay(input: {
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

function AuthMethodPickerOverlay(input: {
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

function CommandPaletteOverlay(input: {
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

function HelpHubOverlay(input: {
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

function OAuthWaitOverlay(input: {
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

function SelectOverlay(input: {
  payload: CliSelectOverlayPayload;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
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
        maxVisible={12}
      />
    </OverlaySurface>
  );
}

function ConfirmDialogOverlay(input: {
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

export function ModalOverlay(input: {
  overlay: NonNullable<CliShellState["overlay"]["active"]>;
  width: number;
  height: number;
  theme: SessionPalette;
}) {
  return (
    <Switch>
      <Match when={input.overlay.payload?.kind === "pager"}>
        <PagerOverlay
          payload={input.overlay.payload as CliPagerOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "inspect"}>
        <InspectOverlay
          payload={input.overlay.payload as CliInspectOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "notifications"}>
        <NotificationsOverlay
          payload={input.overlay.payload as CliNotificationsOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "sessions"}>
        <SessionsOverlay
          payload={input.overlay.payload as CliSessionsOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "tasks"}>
        <TasksOverlay
          payload={input.overlay.payload as CliTasksOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "confirm"}>
        <ConfirmDialogOverlay
          payload={input.overlay.payload as CliConfirmOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "input"}>
        <InputOverlay
          payload={input.overlay.payload as CliInputOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "select"}>
        <SelectOverlay
          payload={input.overlay.payload as CliSelectOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "modelPicker"}>
        <ModelPickerOverlay
          payload={input.overlay.payload as CliModelPickerOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "providerPicker"}>
        <ProviderPickerOverlay
          payload={input.overlay.payload as CliProviderPickerOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "thinkingPicker"}>
        <ThinkingPickerOverlay
          payload={input.overlay.payload as CliThinkingPickerOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "authMethodPicker"}>
        <AuthMethodPickerOverlay
          payload={input.overlay.payload as CliAuthMethodPickerOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "commandPalette"}>
        <CommandPaletteOverlay
          payload={input.overlay.payload as CliCommandPaletteOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "helpHub"}>
        <HelpHubOverlay
          payload={input.overlay.payload as CliHelpHubOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
      <Match when={input.overlay.payload?.kind === "oauthWait"}>
        <OAuthWaitOverlay
          payload={input.overlay.payload as CliOAuthWaitOverlayPayload}
          theme={input.theme}
          width={input.width}
          height={input.height}
        />
      </Match>
    </Switch>
  );
}

export type { CliApprovalOverlayPayload, CliQuestionOverlayPayload, CliShellOverlayPayload };
