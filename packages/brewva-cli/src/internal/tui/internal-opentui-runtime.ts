export type OpenTuiScreenMode = "alternate-screen" | "split-footer" | "main-screen";
export type OpenTuiTerminalBackgroundMode = "dark" | "light";
export type OpenTuiSolidNode = () => unknown;

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

export interface OpenTuiScrollBoxHandle {
  isDestroyed?: boolean;
  scrollTop: number;
  scrollHeight: number;
  scrollBy(delta: number): void;
  scrollTo(offset: number): void;
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

/**
 * The CliRenderer members the split-footer shell actually reads that the
 * minimal {@link OpenTuiRenderer} does not declare. Only primitive/plain-callback
 * members are listed here so this stays inside the OpenTUI import quarantine
 * (no `@opentui/core` types leak into `src/internal/tui`). `createScrollbackSurface`
 * / `writeToScrollback` are deliberately NOT declared: their `ScrollbackSurface`
 * and writer types are OpenTUI-owned, so their call sites keep a local structural
 * cast instead.
 *
 *  - `isDestroyed`: post-teardown liveness guard (the scrollback writer bails
 *    before committing against a dead renderer).
 *  - `terminalHeight`: stable full-terminal row count (NOT the split render
 *    region `height`) the footer-height router caps against.
 *  - `footerHeight`: the fixed footer allocation the router keeps in sync with
 *    the laid-out footer content height.
 *  - `on` / `off`: renderer event subscription (`resize` / `frame`) the footer
 *    router uses to recompute on terminal/layout changes.
 */
export interface SplitFooterRenderer extends OpenTuiRenderer {
  readonly isDestroyed: boolean;
  readonly terminalHeight: number;
  footerHeight: number;
  on(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
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

export interface OpenTuiSplitFooterSmokeResult {
  backend: "opentui-split-footer";
  committedRows: number;
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

export async function createOpenTuiSplitFooterRenderer(_options?: {
  footerHeight?: number;
}): Promise<OpenTuiRenderer> {
  throw createUnsupportedRuntimeError();
}

export function shutdownSplitFooterRenderer(_renderer: OpenTuiRenderer): void {
  throw createUnsupportedRuntimeError();
}

export async function runOpenTuiSplitFooterSmoke(_options?: {
  label?: string;
}): Promise<OpenTuiSplitFooterSmokeResult> {
  throw createUnsupportedRuntimeError();
}
