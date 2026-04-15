/** @jsxImportSource @opentui/solid */

import { For, Match, Show, Switch, createMemo } from "solid-js";
import type { CliShellState } from "../../src/shell/state/index.js";
import { buildTaskRunListLabel, buildTaskRunPreviewLines } from "../../src/shell/task-details.js";
import type {
  CliApprovalOverlayPayload,
  CliConfirmOverlayPayload,
  CliInputOverlayPayload,
  CliInspectOverlayPayload,
  CliNotificationsOverlayPayload,
  CliPagerOverlayPayload,
  CliQuestionOverlayPayload,
  CliSelectOverlayPayload,
  CliSessionsOverlayPayload,
  CliShellOverlayPayload,
  CliTasksOverlayPayload,
} from "../../src/shell/types.js";
import { type SessionPalette } from "./palette.js";
import { TextLineBlock } from "./transcript.js";
import {
  renderNotificationSummary,
  resolveOverlaySurfaceDimensions,
  visibleLineWindow,
  windowSelection,
} from "./utils.js";

function OverlaySurface(input: {
  width: number;
  height: number;
  title: string;
  theme: SessionPalette;
  footer?: string;
  children: unknown;
}) {
  const dimensions = resolveOverlaySurfaceDimensions(input.width, input.height);
  return (
    <box
      position="absolute"
      zIndex={30}
      left={Math.max(2, Math.floor((input.width - dimensions.surfaceWidth) / 2))}
      top={Math.max(1, Math.floor((input.height - dimensions.surfaceHeight) / 2))}
      width={dimensions.surfaceWidth}
      height={dimensions.surfaceHeight}
      border={true}
      borderColor={input.theme.border}
      backgroundColor={input.theme.backgroundOverlay}
      padding={1}
      flexDirection="column"
    >
      <text fg={input.theme.text}>{input.title}</text>
      <box
        width="100%"
        height={dimensions.contentHeight}
        flexDirection="column"
        marginTop={1}
        flexShrink={0}
      >
        {input.children}
      </box>
      <Show when={input.footer}>
        <text fg={input.theme.textMuted} flexShrink={0}>
          {input.footer}
        </text>
      </Show>
    </box>
  );
}

function SelectionList(input: {
  items: readonly string[];
  selectedIndex: number;
  theme: SessionPalette;
  maxVisible?: number;
}) {
  const selectionWindow = windowSelection(input.items, input.selectedIndex, input.maxVisible ?? 8);
  return (
    <box
      width="100%"
      flexDirection="column"
      border={true}
      borderColor={input.theme.borderSubtle}
      backgroundColor={input.theme.backgroundPanel}
      padding={1}
    >
      <For each={selectionWindow.items}>
        {(item, index) => {
          const absoluteIndex = selectionWindow.startIndex + index();
          const selected = absoluteIndex === input.selectedIndex;
          return (
            <text
              fg={selected ? input.theme.selectionText : input.theme.text}
              bg={selected ? input.theme.selectionBg : undefined}
            >
              {selected ? "›" : " "} {item}
            </text>
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
  const surface = resolveOverlaySurfaceDimensions(input.width, input.height);
  const lineWindow = createMemo(() =>
    visibleLineWindow(input.payload.lines, input.payload.scrollOffset, surface.contentHeight),
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
  const surface = resolveOverlaySurfaceDimensions(input.width, input.height);
  const section = createMemo(() => input.payload.sections[input.payload.selectedIndex]);
  const lines = createMemo(() => section()?.lines ?? []);
  const lineWindow = createMemo(() =>
    visibleLineWindow(
      lines(),
      input.payload.scrollOffsets[input.payload.selectedIndex] ?? 0,
      Math.max(4, surface.contentHeight - 2),
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
  return (
    <OverlaySurface
      title="Notifications"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="d dismiss · x clear all · Enter open"
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={34} flexShrink={0}>
          <SelectionList
            items={input.payload.notifications.map((item) => renderNotificationSummary(item))}
            selectedIndex={input.payload.selectedIndex}
            theme={input.theme}
            maxVisible={10}
          />
        </box>
        <box flexGrow={1} flexDirection="column">
          <Show when={notification()}>
            {(entry) => (
              <TextLineBlock
                lines={[
                  `id: ${entry().id}`,
                  `level: ${entry().level}`,
                  "",
                  ...entry().message.split(/\r?\n/u),
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
      title="Input"
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="Enter confirm · Esc cancel"
    >
      <box flexDirection="column" gap={1}>
        <Show when={input.payload.message}>
          <text fg={input.theme.textMuted}>{input.payload.message}</text>
        </Show>
        <box border={true} borderColor={input.theme.borderSubtle} paddingLeft={1} paddingRight={1}>
          <text fg={input.theme.text}>{input.payload.value}</text>
        </box>
      </box>
    </OverlaySurface>
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
    </Switch>
  );
}

export type { CliApprovalOverlayPayload, CliQuestionOverlayPayload, CliShellOverlayPayload };
