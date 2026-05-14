import { spawn } from "node:child_process";
import process from "node:process";
import type { BrewvaUiDialogOptions } from "@brewva/brewva-substrate/host-api";
import {
  DEFAULT_TUI_THEME,
  getTuiTheme,
  listTuiThemes,
  resolveTuiTheme,
  type TuiTheme,
} from "@brewva/brewva-tui";
import {
  cloneCliShellPromptParts,
  rebasePromptPartsAfterTextReplace,
} from "../domain/prompt-parts.js";
import type { CliShellAction, CliShellViewState } from "../domain/state.js";
import type { CliShellUiPort } from "./ui-port.js";

function openUrlInBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const command =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
    resolve();
  });
}

interface CliShellDialogRequest {
  id: string;
  kind: "confirm" | "input" | "select";
  title: string;
  message?: string;
  options?: string[];
  masked?: boolean;
  compact?: boolean;
}

export function createCliShellUiPortController(input: {
  commit(action: CliShellAction): void;
  getState(): CliShellViewState;
  requestDialog<T>(request: CliShellDialogRequest): Promise<T>;
  requestCustom<T>(kind: string, payload: unknown, opts?: BrewvaUiDialogOptions): Promise<T>;
  openExternalEditor(title: string, prefill?: string): Promise<string | undefined>;
  copyTextToClipboard?: (this: void, text: string) => Promise<void>;
  requestRender(): void;
}): {
  ui: CliShellUiPort;
  emitTerminalInput(text: string): void;
} {
  const terminalInputListeners = new Set<(input: string) => unknown>();

  const ui: CliShellUiPort = {
    async select(title, options) {
      return input.requestDialog<string | undefined>({
        id: `select:${Date.now()}`,
        kind: "select",
        title,
        options,
      });
    },
    async confirm(title, message) {
      return input.requestDialog<boolean>({
        id: `confirm:${Date.now()}`,
        kind: "confirm",
        title,
        message,
      });
    },
    async input(title, placeholder) {
      return input.requestDialog<string | undefined>({
        id: `input:${Date.now()}`,
        kind: "input",
        title,
        message: placeholder,
      });
    },
    notify(message, level = "info") {
      input.commit({
        type: "notification.add",
        notification: {
          id: `notification:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
          level,
          message,
          createdAt: Date.now(),
        },
      });
    },
    onTerminalInput(handler) {
      terminalInputListeners.add(handler);
      return () => {
        terminalInputListeners.delete(handler);
      };
    },
    setStatus(key, text) {
      input.commit({
        type: "status.set",
        key,
        text,
      });
    },
    setWorkingMessage(message) {
      input.commit({
        type: "status.working",
        text: message,
      });
    },
    setHiddenThinkingLabel(label) {
      input.commit({
        type: "status.hiddenThinking",
        text: label,
      });
    },
    async custom<T>(kind: string, payload: unknown, opts?: BrewvaUiDialogOptions) {
      return await input.requestCustom<T>(kind, payload, opts);
    },
    async openUrl(url) {
      await openUrlInBrowser(url);
    },
    pasteToEditor(text) {
      const state = input.getState();
      const nextText =
        state.composer.text.slice(0, state.composer.cursor) +
        text +
        state.composer.text.slice(state.composer.cursor);
      input.commit({
        type: "composer.setPromptState",
        text: nextText,
        cursor: state.composer.cursor + text.length,
        parts: rebasePromptPartsAfterTextReplace(cloneCliShellPromptParts(state.composer.parts), {
          start: state.composer.cursor,
          end: state.composer.cursor,
          replacementText: text,
        }),
      });
    },
    setEditorText(text) {
      input.commit({
        type: "composer.setText",
        text,
        cursor: text.length,
      });
    },
    getEditorText() {
      return input.getState().composer.text;
    },
    editor(title, prefill) {
      return input.openExternalEditor(title, prefill);
    },
    setEditorComponent() {},
    get theme() {
      return input.getState().theme;
    },
    getAllThemes() {
      return [{ name: "default" }, ...listTuiThemes()];
    },
    getTheme(name) {
      if (name === "default") {
        return DEFAULT_TUI_THEME;
      }
      return getTuiTheme(name);
    },
    setTheme(nextTheme) {
      const resolvedTheme =
        typeof nextTheme === "string" && nextTheme === "default"
          ? DEFAULT_TUI_THEME
          : resolveTuiTheme(nextTheme as string | TuiTheme);
      if (!resolvedTheme) {
        return {
          success: false,
          error: "Unknown theme selection.",
        };
      }
      input.commit({
        type: "theme.set",
        theme: resolvedTheme,
      });
      return { success: true };
    },
    getToolsExpanded() {
      return input.getState().view.toolDetails;
    },
    setToolsExpanded(expanded) {
      input.commit({
        type: "view.setPreferences",
        preferences: {
          toolDetails: expanded,
        },
      });
    },
  };
  if (input.copyTextToClipboard) {
    ui.copyText = input.copyTextToClipboard;
  }
  return {
    ui,
    emitTerminalInput(text) {
      for (const listener of terminalInputListeners) {
        listener(text);
      }
    },
  };
}

export function createCliShellUiPort(
  input: Parameters<typeof createCliShellUiPortController>[0],
): CliShellUiPort {
  return createCliShellUiPortController(input).ui;
}
