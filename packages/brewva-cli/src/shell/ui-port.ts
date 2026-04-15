import {
  DEFAULT_TUI_THEME,
  getTuiTheme,
  listTuiThemes,
  resolveTuiTheme,
  type TuiTheme,
} from "@brewva/brewva-tui";
import { cloneCliShellPromptParts, rebasePromptPartsAfterTextReplace } from "./prompt-parts.js";
import type { CliShellAction, CliShellState } from "./state/index.js";
import type { CliShellUiPort } from "./types.js";

function normalizeLines(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\r?\n/u);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (value && typeof value === "object" && "render" in value) {
    const render = (value as { render?: (width: number) => unknown }).render;
    if (typeof render === "function") {
      const rendered = render(120);
      return Array.isArray(rendered) ? rendered.map((entry) => String(entry)) : [];
    }
  }
  return [];
}

interface CliShellDialogRequest<T> {
  id: string;
  kind: "confirm" | "input" | "select";
  title: string;
  message?: string;
  options?: string[];
  resolve(value: T): void;
}

export function createCliShellUiPortController(input: {
  dispatch(action: CliShellAction): void;
  getState(): CliShellState;
  requestDialog<T>(request: CliShellDialogRequest<T>): Promise<T>;
  openExternalEditor(title: string, prefill?: string): Promise<string | undefined>;
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
        resolve: (value) => value,
      });
    },
    async confirm(title, message) {
      return input.requestDialog<boolean>({
        id: `confirm:${Date.now()}`,
        kind: "confirm",
        title,
        message,
        resolve: (value) => value,
      });
    },
    async input(title, placeholder) {
      return input.requestDialog<string | undefined>({
        id: `input:${Date.now()}`,
        kind: "input",
        title,
        message: placeholder,
        resolve: (value) => value,
      });
    },
    notify(message, level = "info") {
      input.dispatch({
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
      input.dispatch({
        type: "status.set",
        key,
        text,
      });
    },
    setWorkingMessage(message) {
      input.dispatch({
        type: "status.working",
        text: message,
      });
    },
    setHiddenThinkingLabel(label) {
      input.dispatch({
        type: "status.hiddenThinking",
        text: label,
      });
    },
    setWidget(...args) {
      const [id, lines, options] = args as [string, string[] | undefined, { placement?: string }?];
      input.dispatch({
        type: "status.widget",
        id,
        lines,
        placement: options?.placement,
      });
    },
    setFooter(factory) {
      input.dispatch({
        type: "status.footer",
        lines: normalizeLines(factory),
      });
    },
    setHeader(factory) {
      input.dispatch({
        type: "status.header",
        lines: normalizeLines(factory),
      });
    },
    setTitle(title) {
      input.dispatch({
        type: "status.title",
        title,
      });
    },
    async custom() {
      return undefined as never;
    },
    pasteToEditor(text) {
      const state = input.getState();
      const nextText =
        state.composer.text.slice(0, state.composer.cursor) +
        text +
        state.composer.text.slice(state.composer.cursor);
      input.dispatch({
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
      input.dispatch({
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
      input.dispatch({
        type: "theme.set",
        theme: resolvedTheme,
      });
      return { success: true };
    },
    getToolsExpanded() {
      return input.getState().status.toolsExpanded;
    },
    setToolsExpanded(expanded) {
      input.dispatch({
        type: "status.toolsExpanded",
        expanded,
      });
    },
  };
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
