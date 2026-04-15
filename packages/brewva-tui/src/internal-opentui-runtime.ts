import type React from "react";

export type OpenTuiScreenMode = "alternate-screen";
export type OpenTuiTerminalBackgroundMode = "dark" | "light";

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

export interface OpenTuiRenderer {
  width: number;
  height: number;
  destroy(): void;
}

export interface OpenTuiRoot {
  render(node: React.ReactNode): void;
  unmount(): void;
}

export interface OpenTuiReactRuntime {
  createElement: typeof React.createElement;
  useEffect: typeof React.useEffect;
  useMemo: typeof React.useMemo;
  useState: typeof React.useState;
  useSyncExternalStore: typeof React.useSyncExternalStore;
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
}

export interface OpenTuiTestRenderSetup {
  renderer: OpenTuiRenderer;
  mockInput: OpenTuiTestInputDriver;
  renderOnce(): Promise<void>;
  captureCharFrame(): string;
}

export type OpenTuiSolidNode = () => unknown;

export interface OpenTuiTestRenderOptions {
  width: number;
  height: number;
  onDestroy?(): void;
}

const UNSUPPORTED_RUNTIME_MESSAGE =
  "OpenTUI runtime is only available from Bun source execution or packaged Brewva binaries; direct Node.js dist execution cannot load the native interactive runtime.";

function createUnsupportedRuntimeError(): Error {
  return new Error(UNSUPPORTED_RUNTIME_MESSAGE);
}

export const OPEN_TUI_RUNTIME_KIND = "node-stub";
export const openTuiReact: OpenTuiReactRuntime = {
  createElement() {
    throw createUnsupportedRuntimeError();
  },
  useEffect() {
    throw createUnsupportedRuntimeError();
  },
  useMemo() {
    throw createUnsupportedRuntimeError();
  },
  useState() {
    throw createUnsupportedRuntimeError();
  },
  useSyncExternalStore() {
    throw createUnsupportedRuntimeError();
  },
};

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

export async function createOpenTuiCliRenderer(): Promise<OpenTuiRenderer> {
  throw createUnsupportedRuntimeError();
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
): React.ReactNode {
  throw createUnsupportedRuntimeError();
}

export async function openTuiAct(_callback: () => void | Promise<void>): Promise<void> {
  throw createUnsupportedRuntimeError();
}

export async function openTuiTestRender(
  _node: React.ReactNode,
  _options: OpenTuiTestRenderOptions,
): Promise<OpenTuiTestRenderSetup> {
  throw createUnsupportedRuntimeError();
}

export async function runOpenTuiSmoke(
  _options: OpenTuiSmokeOptions = {},
): Promise<OpenTuiSmokeResult> {
  throw createUnsupportedRuntimeError();
}
