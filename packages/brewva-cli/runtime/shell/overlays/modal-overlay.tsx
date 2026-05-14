/** @jsxImportSource @opentui/solid */

import { createMemo } from "solid-js";
import type { ShellViewModel } from "../../../src/shell/domain/view-model.js";
import type { SessionPalette } from "../palette.js";
import {
  InboxOverlay,
  InspectOverlay,
  LineageOverlay,
  NotificationsOverlay,
  PagerOverlay,
  QueueOverlay,
  SessionsOverlay,
  TasksOverlay,
} from "./data-overlays.js";
import {
  ConfirmDialogOverlay,
  InputOverlay,
  OAuthWaitOverlay,
  SelectOverlay,
} from "./form-overlays.js";
import {
  AuthMethodPickerOverlay,
  CommandPaletteOverlay,
  HelpHubOverlay,
  ModelPickerOverlay,
  ProviderPickerOverlay,
  ThinkingPickerOverlay,
} from "./picker-overlays.js";

export function ModalOverlay(input: {
  overlay: NonNullable<ShellViewModel["overlay"]["active"]>;
  width: number;
  height: number;
  theme: SessionPalette;
}) {
  const rendered = createMemo(() => {
    const payload = input.overlay.payload;
    if (!payload) {
      return null;
    }

    switch (payload.kind) {
      case "pager":
        return (
          <PagerOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "inspect":
        return (
          <InspectOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "notifications":
        return (
          <NotificationsOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "inbox":
        return (
          <InboxOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "sessions":
        return (
          <SessionsOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "lineage":
        return (
          <LineageOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "queue":
        return (
          <QueueOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "tasks":
        return (
          <TasksOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "confirm":
        return (
          <ConfirmDialogOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "input":
        return (
          <InputOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "select":
        return (
          <SelectOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "modelPicker":
        return (
          <ModelPickerOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "providerPicker":
        return (
          <ProviderPickerOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "thinkingPicker":
        return (
          <ThinkingPickerOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "authMethodPicker":
        return (
          <AuthMethodPickerOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "commandPalette":
        return (
          <CommandPaletteOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "helpHub":
        return (
          <HelpHubOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "oauthWait":
        return (
          <OAuthWaitOverlay
            payload={payload}
            theme={input.theme}
            width={input.width}
            height={input.height}
          />
        );
      case "approval":
      case "question":
        return null;
      default: {
        const exhaustiveCheck: never = payload;
        return exhaustiveCheck;
      }
    }
  });

  return <>{rendered()}</>;
}
