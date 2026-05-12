import type { BrewvaToolUiPort } from "@brewva/brewva-substrate/host-api";

export const NOOP_UI: BrewvaToolUiPort = {
  async select() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async input() {
    return undefined;
  },
  notify() {},
  onTerminalInput() {
    return () => undefined;
  },
  setStatus() {},
  setWorkingMessage() {},
  setHiddenThinkingLabel() {},
  async custom() {
    return undefined as never;
  },
  pasteToEditor() {},
  setEditorText() {},
  getEditorText() {
    return "";
  },
  async editor() {
    return undefined;
  },
  setEditorComponent() {},
  theme: {},
  getAllThemes() {
    return [];
  },
  getTheme() {
    return undefined;
  },
  setTheme() {
    return { success: false, error: "UI unavailable" };
  },
  getToolsExpanded() {
    return true;
  },
  setToolsExpanded() {},
};
