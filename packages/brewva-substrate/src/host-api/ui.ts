export interface BrewvaUiDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export type BrewvaUiThemeDescriptor = object;

export interface BrewvaUiThemeEntry {
  name: string;
  path?: string;
}

export interface BrewvaThemeSelectionResult {
  success: boolean;
  error?: string;
}

export interface BrewvaToolUiPort {
  select(
    title: string,
    options: string[],
    opts?: BrewvaUiDialogOptions,
  ): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: BrewvaUiDialogOptions): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    opts?: BrewvaUiDialogOptions,
  ): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  onTerminalInput(handler: (input: string) => unknown): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(...args: readonly unknown[]): void;
  setFooter(factory: unknown): void;
  setHeader(factory: unknown): void;
  setTitle(title: string): void;
  custom<T>(...args: readonly unknown[]): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  setEditorComponent(factory: unknown): void;
  readonly theme: BrewvaUiThemeDescriptor;
  getAllThemes(): BrewvaUiThemeEntry[];
  getTheme(name: string): BrewvaUiThemeDescriptor | undefined;
  setTheme(theme: string | BrewvaUiThemeDescriptor): BrewvaThemeSelectionResult;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}
