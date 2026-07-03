export type OpenTuiScreenMode = "alternate-screen" | "split-footer" | "main-screen";
export type OpenTuiTerminalBackgroundMode = "dark" | "light";

/**
 * Opaque view of an OpenTUI/Solid renderable. Kept structural so this
 * quarantined layer never imports `@opentui/solid` (its public `JSX.Element`
 * union is OpenTUI-owned). The runtime adapter re-brands these values into the
 * concrete `JSX.Element` contract at its single `asOpenTuiJsxElement` boundary
 * before handing them to `render`/`testRender`.
 */
export type OpenTuiSolidRenderable = unknown;

/**
 * A Solid render thunk. The return value is intentionally opaque here so the
 * quarantine stays `@opentui`-free; the runtime adapter adapts the thunk to
 * @opentui/solid 0.4.x's `(node: () => JSX.Element)` shape at its boundary.
 */
export type OpenTuiSolidNode = () => OpenTuiSolidRenderable;

export interface OpenTuiKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface OpenTuiTextareaHandle {
  isDestroyed?: boolean;
  plainText: string;
  cursorOffset?: number;
  logicalCursor: {
    row: number;
    col: number;
  };
  focus(): void;
  blur(): void;
  clear(): void;
  insertText(text: string): void;
  gotoBufferEnd?(): void;
  setText(text: string): void;
  setCursor(row: number, col: number): void;
  extmarks: {
    registerType(name: string): number;
    clear(): void;
    create(input: {
      start: number;
      end: number;
      virtual?: boolean;
      styleId?: number;
      typeId: number;
    }): number;
    getAllForTypeId(typeId: number): Array<{
      id: number;
      start: number;
      end: number;
    }>;
  };
  editBuffer: {
    on(event: "content-changed" | "cursor-changed", handler: () => void): void;
    off(event: "content-changed" | "cursor-changed", handler: () => void): void;
  };
}

export interface OpenTuiScrollBoxChild {
  readonly id?: string | number;
  readonly y: number;
}

export interface OpenTuiScrollBoxHandle {
  isDestroyed?: boolean;
  y: number;
  height: number;
  scrollTop: number;
  scrollHeight: number;
  scrollBy(delta: number): void;
  scrollTo(offset: number): void;
  getChildren(): readonly OpenTuiScrollBoxChild[];
  viewport: {
    height: number;
  };
  stickyScroll: boolean;
  stickyStart?: "bottom" | "top" | "left" | "right";
}

export interface OpenTuiSelection {
  getSelectedText(): string;
}

export interface OpenTuiConsoleHandle {
  onCopySelection?: (text: string) => void;
}

export interface OpenTuiRenderer {
  width: number;
  height: number;
  console?: OpenTuiConsoleHandle;
  getSelection?(): OpenTuiSelection | null;
  clearSelection?(): void;
  copyToClipboardOSC52?(text: string): boolean;
  destroy(): void;
}

export interface OpenTuiRoot {
  render(node: OpenTuiSolidNode): void | Promise<void>;
  unmount(): void;
}

export interface OpenTuiSmokeOptions {
  label?: string;
  screenMode?: OpenTuiScreenMode;
}

export interface OpenTuiSmokeResult {
  backend: "opentui";
  label?: string;
  screenMode: OpenTuiScreenMode;
}

export interface OpenTuiTestKeyboardModifiers {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface OpenTuiTestInputDriver {
  pressKey(key: string, modifiers?: OpenTuiTestKeyboardModifiers): void;
  pressEnter(modifiers?: OpenTuiTestKeyboardModifiers): void;
  typeText(text: string, delayMs?: number): Promise<void>;
}

/**
 * Opaque view of the native renderer statistics counter set. Kept
 * structural so the quarantine layer never imports OpenTUI types.
 */
export type OpenTuiNativeRenderStats = Readonly<Record<string, unknown>>;

export interface OpenTuiTestRenderSetup {
  renderer: OpenTuiRenderer;
  mockInput: OpenTuiTestInputDriver;
  renderOnce(): Promise<void>;
  captureCharFrame(): string;
  getNativeStats?(): OpenTuiNativeRenderStats;
}

export interface OpenTuiTestRenderOptions {
  width: number;
  height: number;
  /** Enable native renderer statistics gathering (benchmark harness only). */
  gatherStats?: boolean;
  /**
   * Drive the mock keyboard through the kitty keyboard protocol (CSI-u
   * encodings) instead of classic ANSI, matching what a kitty-capable terminal
   * sends once the interactive shell enables its kitty keyboard config.
   */
  kittyKeyboard?: boolean;
  onDestroy?(): void;
}

export interface OpenTuiScrollbackRenderOptions {
  width: number;
  height?: number;
}

const UNSUPPORTED_RUNTIME_MESSAGE =
  "OpenTUI runtime is only available from Bun source execution or packaged Brewva binaries; direct Node.js dist execution cannot load the native interactive runtime.";

function createUnsupportedRuntimeError(): Error {
  return new Error(UNSUPPORTED_RUNTIME_MESSAGE);
}

export const OPEN_TUI_RUNTIME_KIND = "node-stub";

export function createOpenTuiSolidElement(
  _type: unknown,
  _props?: Record<string, unknown> | null,
  ..._children: unknown[]
): OpenTuiSolidNode {
  void _type;
  void _props;
  void _children;
  throw createUnsupportedRuntimeError();
}

export async function openTuiSolidAct(_callback: () => void | Promise<void>): Promise<void> {
  throw createUnsupportedRuntimeError();
}

export async function openTuiSolidTestRender(
  _node: OpenTuiSolidNode,
  _options: OpenTuiTestRenderOptions,
): Promise<OpenTuiTestRenderSetup> {
  throw createUnsupportedRuntimeError();
}

export function isOpenTuiRuntimeAvailable(): boolean {
  return false;
}

export function createOpenTuiRoot(_renderer: OpenTuiRenderer): OpenTuiRoot {
  throw createUnsupportedRuntimeError();
}

export function useOpenTuiKeyboard(_handler: (event: OpenTuiKeyEvent) => void): void {
  throw createUnsupportedRuntimeError();
}

export function useOpenTuiTerminalDimensions(): { width: number; height: number } {
  throw createUnsupportedRuntimeError();
}

export async function getOpenTuiTerminalBackgroundMode(): Promise<OpenTuiTerminalBackgroundMode> {
  return "dark";
}

export function createOpenTuiElement(
  _type: unknown,
  _props?: Record<string, unknown> | null,
  ..._children: unknown[]
): OpenTuiSolidNode {
  throw createUnsupportedRuntimeError();
}

export async function openTuiAct(_callback: () => void | Promise<void>): Promise<void> {
  throw createUnsupportedRuntimeError();
}

export async function openTuiTestRender(
  _node: OpenTuiSolidNode,
  _options: OpenTuiTestRenderOptions,
): Promise<OpenTuiTestRenderSetup> {
  throw createUnsupportedRuntimeError();
}

export async function renderOpenTuiScrollbackLines(
  _node: OpenTuiSolidNode,
  _options: OpenTuiScrollbackRenderOptions,
): Promise<string[]> {
  throw createUnsupportedRuntimeError();
}

export async function runOpenTuiSmoke(
  _options: OpenTuiSmokeOptions = {},
): Promise<OpenTuiSmokeResult> {
  throw createUnsupportedRuntimeError();
}
