/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js";
import type { CliShellController } from "../../src/shell/controller.js";
import type { CliShellState } from "../../src/shell/state/index.js";
import { buildTaskRunListLabel } from "../../src/shell/task-details.js";
import { DEFAULT_SCROLL_ACCELERATION, type SessionPalette } from "./palette.js";

function SidebarSection(input: {
  title: string;
  lines: readonly string[];
  theme: SessionPalette;
  onClick?: () => void;
}) {
  return (
    <Show when={input.lines.length > 0}>
      <box
        flexDirection="column"
        gap={0}
        paddingTop={1}
        paddingBottom={1}
        onMouseUp={() => input.onClick?.()}
      >
        <text fg={input.theme.textMuted}>
          <b>{input.title}</b>
        </text>
        <For each={input.lines}>{(line) => <text fg={input.theme.text}>{line}</text>}</For>
      </box>
    </Show>
  );
}

export function SidebarPanel(input: {
  controller: CliShellController;
  state: CliShellState;
  theme: SessionPalette;
  overlay?: boolean;
}) {
  const snapshot = createMemo(() => input.controller.getOperatorSnapshot());
  const bundle = createMemo(() => input.controller.getBundle());
  const widgets = createMemo(() => Object.entries(input.state.status.widgets));
  const sessionId = createMemo(() => bundle().session.sessionManager.getSessionId());
  const title = createMemo(() => input.state.status.title?.trim() || sessionId());
  const model = createMemo(() => {
    const currentModel = bundle().session.model;
    if (!currentModel?.provider || !currentModel.id) {
      return "unresolved-model";
    }
    return `${currentModel.provider}/${currentModel.id}`;
  });
  const recentTask = createMemo(() => snapshot().taskRuns[0]);
  const taskLines = createMemo(() => {
    const task = recentTask();
    return task
      ? [`runs=${snapshot().taskRuns.length}`, buildTaskRunListLabel(task)]
      : [`runs=${snapshot().taskRuns.length}`];
  });
  return (
    <box
      backgroundColor={input.theme.backgroundPanel}
      width={42}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      position={input.overlay ? "absolute" : "relative"}
    >
      <scrollbox
        flexGrow={1}
        scrollAcceleration={DEFAULT_SCROLL_ACCELERATION}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: input.theme.background,
            foregroundColor: input.theme.borderActive,
          },
        }}
      >
        <box flexShrink={0} gap={1} paddingRight={1} flexDirection="column">
          <box paddingRight={1} flexDirection="column">
            <text fg={input.theme.text}>
              <b>{title()}</b>
            </text>
            <Show when={title() !== sessionId()}>
              <text fg={input.theme.textMuted}>{sessionId()}</text>
            </Show>
            <text fg={input.theme.textMuted}>{model()}</text>
            <text fg={input.theme.textMuted}>
              thinking={bundle().session.thinkingLevel ?? "off"}
            </text>
            <For each={input.state.status.headerLines}>
              {(line) => <text fg={input.theme.textMuted}>{line}</text>}
            </For>
          </box>

          <SidebarSection
            title="Session"
            lines={[
              `messages=${input.state.transcript.messages.length}`,
              `overlay=${input.state.overlay.active?.kind ?? "none"}`,
            ]}
            theme={input.theme}
            onClick={() => {
              void input.controller.openInspectPanel();
            }}
          />

          <SidebarSection
            title="Inbox"
            lines={[
              `approvals=${snapshot().approvals.length}`,
              `questions=${snapshot().questions.length}`,
              `notifications=${input.state.notifications.length}`,
            ]}
            theme={input.theme}
            onClick={() => input.controller.openNotificationsInbox()}
          />

          <SidebarSection
            title="Tasks"
            lines={taskLines()}
            theme={input.theme}
            onClick={() => input.controller.openTasksOverlay()}
          />

          <SidebarSection
            title="Replay"
            lines={[`sessions=${snapshot().sessions.length}`]}
            theme={input.theme}
            onClick={() => input.controller.openSessionsBrowser()}
          />

          <For each={widgets()}>
            {([id, widget]) => (
              <SidebarSection title={id} lines={widget.lines} theme={input.theme} />
            )}
          </For>

          <SidebarSection
            title="Footer"
            lines={input.state.status.footerLines}
            theme={input.theme}
          />
        </box>
      </scrollbox>
      <box flexShrink={0} gap={1} paddingTop={1}>
        <text fg={input.theme.textMuted}>
          <span style={{ fg: input.theme.success }}>•</span> <b>Brewva</b>
        </text>
      </box>
    </box>
  );
}
