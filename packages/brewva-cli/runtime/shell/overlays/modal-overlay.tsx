/** @jsxImportSource @opentui/solid */

import { Show, createMemo } from "solid-js";
import type { CliShellOverlayPayload } from "../../../src/shell/domain/overlays/payloads.js";
import type { ShellViewModel } from "../../../src/shell/domain/view-model.js";
import type { SessionPalette } from "../palette.js";
import { ApprovalOverlay } from "./approval-overlay.js";
import {
  CockpitArchiveOverlay,
  CockpitAttentionOverlay,
  InboxOverlay,
  InspectOverlay,
  LineageOverlay,
  NotificationsOverlay,
  PagerOverlay,
  QueueOverlay,
  SessionsOverlay,
  TasksOverlay,
  TreeOverlay,
} from "./data-overlays.js";
import {
  ConfirmDialogOverlay,
  InputOverlay,
  OAuthWaitOverlay,
  SelectOverlay,
} from "./form-overlays.js";
import {
  AuthMethodPickerOverlay,
  AuthorityOverlay,
  CommandPaletteOverlay,
  ContextOverlay,
  HelpHubOverlay,
  ModelPickerOverlay,
  ProviderPickerOverlay,
  SkillsOverlay,
  ShortcutOverlay,
  ThinkingPickerOverlay,
} from "./picker-overlays.js";
import { QuestionOverlay } from "./question-overlay.js";

type OverlayPayloadOf<TKind extends CliShellOverlayPayload["kind"]> = Extract<
  CliShellOverlayPayload,
  { kind: TKind }
>;

function overlayPayloadOf<TKind extends CliShellOverlayPayload["kind"]>(
  payload: CliShellOverlayPayload | undefined,
  kind: TKind,
): OverlayPayloadOf<TKind> | undefined {
  return payload?.kind === kind ? (payload as OverlayPayloadOf<TKind>) : undefined;
}

export function ModalOverlay(input: {
  overlay: NonNullable<ShellViewModel["overlay"]["active"]>;
  width: number;
  height: number;
  theme: SessionPalette;
}) {
  const payload = createMemo(() => input.overlay.payload);

  return (
    <>
      <Show when={overlayPayloadOf(payload(), "pager")}>
        {(current) => (
          <PagerOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "approval")}>
        {(current) => (
          <ApprovalOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "question")}>
        {(current) => (
          <QuestionOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "inspect")}>
        {(current) => (
          <InspectOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "notifications")}>
        {(current) => (
          <NotificationsOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "inbox")}>
        {(current) => (
          <InboxOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "sessions")}>
        {(current) => (
          <SessionsOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "lineage")}>
        {(current) => (
          <LineageOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "tree")}>
        {(current) => (
          <TreeOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "queue")}>
        {(current) => (
          <QueueOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "tasks")}>
        {(current) => (
          <TasksOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "confirm")}>
        {(current) => (
          <ConfirmDialogOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "input")}>
        {(current) => (
          <InputOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "select")}>
        {(current) => (
          <SelectOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "modelPicker")}>
        {(current) => (
          <ModelPickerOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "providerPicker")}>
        {(current) => (
          <ProviderPickerOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "thinkingPicker")}>
        {(current) => (
          <ThinkingPickerOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "authMethodPicker")}>
        {(current) => (
          <AuthMethodPickerOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "commandPalette")}>
        {(current) => (
          <CommandPaletteOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "helpHub")}>
        {(current) => (
          <HelpHubOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "context")}>
        {(current) => (
          <ContextOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "authority")}>
        {(current) => (
          <AuthorityOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "cockpitArchive")}>
        {(current) => (
          <CockpitArchiveOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "cockpitAttention")}>
        {(current) => (
          <CockpitAttentionOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "skills")}>
        {(current) => (
          <SkillsOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "shortcutOverlay")}>
        {(current) => (
          <ShortcutOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
      <Show when={overlayPayloadOf(payload(), "oauthWait")}>
        {(current) => (
          <OAuthWaitOverlay
            payload={current()}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        )}
      </Show>
    </>
  );
}
