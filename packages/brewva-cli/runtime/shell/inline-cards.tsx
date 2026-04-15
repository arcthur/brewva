/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, createMemo } from "solid-js";
import type { CliShellController } from "../../src/shell/controller.js";
import type {
  CliApprovalOverlayPayload,
  CliQuestionOverlayPayload,
} from "../../src/shell/types.js";
import { type SessionPalette } from "./palette.js";

export function PromptActionChip(input: {
  label: string;
  active?: boolean;
  theme: SessionPalette;
  onSelect?: () => void;
}) {
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={input.active ? input.theme.warning : input.theme.backgroundMenu}
      onMouseUp={() => input.onSelect?.()}
    >
      <text fg={input.active ? input.theme.selectionText : input.theme.textMuted}>
        {input.label}
      </text>
    </box>
  );
}

function InlinePromptCard(input: {
  title: string;
  theme: SessionPalette;
  accentColor: string;
  header?: unknown;
  body: unknown;
  actions: ReadonlyArray<{
    label: string;
    active?: boolean;
    onSelect?: () => void;
  }>;
  hints: readonly string[];
}) {
  const dimensions = useTerminalDimensions();
  const narrow = createMemo(() => dimensions().width < 90);
  return (
    <box
      backgroundColor={input.theme.backgroundPanel}
      border={["left"]}
      borderColor={input.accentColor}
      customBorderChars={{
        topLeft: "",
        bottomLeft: "",
        vertical: "┃",
        topRight: "",
        bottomRight: "",
        horizontal: " ",
        bottomT: "",
        topT: "",
        cross: "",
        leftT: "",
        rightT: "",
      }}
      flexDirection="column"
    >
      <box
        gap={1}
        paddingLeft={1}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        flexShrink={0}
      >
        <Show
          when={input.header}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
              <text fg={input.accentColor}>△</text>
              <text fg={input.theme.text}>{input.title}</text>
            </box>
          }
        >
          <box paddingLeft={1} flexShrink={0}>
            {input.header}
          </box>
        </Show>
        {input.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={input.theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={input.actions}>
            {(action) => (
              <PromptActionChip
                label={action.label}
                active={action.active}
                theme={input.theme}
                onSelect={action.onSelect}
              />
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <For each={input.hints}>{(hint) => <text fg={input.theme.textMuted}>{hint}</text>}</For>
        </box>
      </box>
    </box>
  );
}

export function InlineApprovalPrompt(input: {
  controller: CliShellController;
  payload: CliApprovalOverlayPayload;
  theme: SessionPalette;
}) {
  const request = createMemo(() => input.payload.snapshot.approvals[input.payload.selectedIndex]);
  return (
    <Show
      when={request()}
      fallback={
        <InlinePromptCard
          title="Approvals"
          theme={input.theme}
          accentColor={input.theme.borderActive}
          body={
            <box paddingLeft={1} flexDirection="column" gap={1}>
              <text fg={input.theme.text}>No pending approvals.</text>
              <text fg={input.theme.textMuted}>
                Brewva will show permission requests here when a tool needs approval.
              </text>
            </box>
          }
          actions={[]}
          hints={["esc close"]}
        />
      }
    >
      {(entry) => (
        <InlinePromptCard
          title="Permission required"
          theme={input.theme}
          accentColor={input.theme.warning}
          header={
            <box flexDirection="row" gap={1}>
              <text fg={input.theme.warning}>△</text>
              <text fg={input.theme.text}>Permission required</text>
            </box>
          }
          body={
            <box paddingLeft={1} flexDirection="column" gap={1}>
              <text fg={input.theme.text}>{entry().subject}</text>
              <text fg={input.theme.textMuted}>Tool: {entry().toolName}</text>
              <text fg={input.theme.textMuted}>Boundary: {entry().boundary}</text>
              <text fg={input.theme.textMuted}>
                Effects: {entry().effects.length > 0 ? entry().effects.join(", ") : "none"}
              </text>
              <Show when={entry().argsSummary}>
                <text fg={input.theme.text}>{entry().argsSummary}</text>
              </Show>
            </box>
          }
          actions={[
            {
              label: "Allow once",
              active: true,
              onSelect: () => {
                void input.controller.handleSemanticInput({
                  key: "enter",
                  ctrl: false,
                  meta: false,
                  shift: false,
                });
              },
            },
            {
              label: "Reject",
              onSelect: () => {
                void input.controller.handleSemanticInput({
                  key: "character",
                  text: "r",
                  ctrl: false,
                  meta: false,
                  shift: false,
                });
              },
            },
          ]}
          hints={["⇆ select", "enter confirm", "r reject", "esc close"]}
        />
      )}
    </Show>
  );
}

export function InlineQuestionPrompt(input: {
  controller: CliShellController;
  payload: CliQuestionOverlayPayload;
  theme: SessionPalette;
}) {
  const question = createMemo(() => input.payload.snapshot.questions[input.payload.selectedIndex]);
  const total = createMemo(() => input.payload.snapshot.questions.length);
  return (
    <Show
      when={question()}
      fallback={
        <InlinePromptCard
          title="Questions"
          theme={input.theme}
          accentColor={input.theme.borderActive}
          body={
            <box paddingLeft={1} flexDirection="column" gap={1}>
              <text fg={input.theme.text}>No open questions.</text>
              <text fg={input.theme.textMuted}>
                Brewva will show delegated questions here when a run needs your input.
              </text>
            </box>
          }
          actions={[]}
          hints={["esc close"]}
        />
      }
    >
      {(entry) => (
        <InlinePromptCard
          title="Question"
          theme={input.theme}
          accentColor={input.theme.warning}
          header={
            <box flexDirection="column" gap={1}>
              <Show when={total() > 1}>
                <box flexDirection="row" gap={1}>
                  <For each={input.payload.snapshot.questions}>
                    {(_candidate, index) => (
                      <PromptActionChip
                        label={`Q${index() + 1}`}
                        active={index() === input.payload.selectedIndex}
                        theme={input.theme}
                      />
                    )}
                  </For>
                </box>
              </Show>
              <box flexDirection="row" gap={1}>
                <text fg={input.theme.warning}>△</text>
                <text fg={input.theme.text}>Question</text>
              </box>
            </box>
          }
          body={
            <box paddingLeft={1} flexDirection="column" gap={1}>
              <text fg={input.theme.text}>{entry().questionText}</text>
              <text fg={input.theme.textMuted}>{entry().sourceLabel}</text>
              <Show when={entry().delegate}>
                <text fg={input.theme.textMuted}>delegate={entry().delegate}</text>
              </Show>
              <Show when={entry().runId}>
                <text fg={input.theme.textMuted}>runId={entry().runId}</text>
              </Show>
            </box>
          }
          actions={[
            {
              label: "Prefill answer",
              active: true,
              onSelect: () => {
                void input.controller.handleSemanticInput({
                  key: "enter",
                  ctrl: false,
                  meta: false,
                  shift: false,
                });
              },
            },
          ]}
          hints={["enter answer", total() > 1 ? "j/k switch" : "", "esc close"].filter(Boolean)}
        />
      )}
    </Show>
  );
}
