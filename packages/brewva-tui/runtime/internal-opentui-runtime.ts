import { createCliRenderer } from "@opentui/core";
import { createElement as createSolidElement, testRender as solidTestRender } from "@opentui/solid";
import React from "react";
import type {
  OpenTuiKeyEvent,
  OpenTuiRenderer,
  OpenTuiRoot,
  OpenTuiScrollBoxHandle,
  OpenTuiSmokeOptions,
  OpenTuiSmokeResult,
  OpenTuiScreenMode,
  OpenTuiSolidNode,
  OpenTuiTerminalBackgroundMode,
  OpenTuiTextareaHandle,
  OpenTuiTestRenderOptions,
  OpenTuiTestRenderSetup,
} from "../src/internal-opentui-runtime.js";
import { useKeyboard } from "./vendor/opentui-react/src/hooks/use-keyboard.js";
import { useTerminalDimensions } from "./vendor/opentui-react/src/hooks/use-terminal-dimensions.js";
import { createElement } from "./vendor/opentui-react/src/index.js";
import { createRoot } from "./vendor/opentui-react/src/reconciler/renderer.js";
import { act, testRender } from "./vendor/opentui-react/src/test-utils.js";

const DEFAULT_SCREEN_MODE: OpenTuiScreenMode = "alternate-screen";
const DEFAULT_KITTY_KEYBOARD_CONFIG = {
  disambiguate: true,
  alternateKeys: true,
  allKeysAsEscapes: true,
  reportText: true,
} as const;

function createCliRendererConfig(
  overrides: Partial<Parameters<typeof createCliRenderer>[0]> = {},
): Parameters<typeof createCliRenderer>[0] {
  return {
    exitOnCtrlC: false,
    screenMode: DEFAULT_SCREEN_MODE,
    useMouse: true,
    consoleMode: "disabled",
    useKittyKeyboard: DEFAULT_KITTY_KEYBOARD_CONFIG,
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    ...overrides,
  };
}

export const OPEN_TUI_RUNTIME_KIND = "bun-runtime";
export const openTuiReact = {
  createElement: React.createElement,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useState: React.useState,
  useSyncExternalStore: React.useSyncExternalStore,
};

export function isOpenTuiRuntimeAvailable(): boolean {
  return true;
}

export async function createOpenTuiCliRenderer(): Promise<OpenTuiRenderer> {
  return await createCliRenderer(createCliRendererConfig());
}

export function createOpenTuiRoot(renderer: OpenTuiRenderer): OpenTuiRoot {
  return createRoot(renderer as Awaited<ReturnType<typeof createCliRenderer>>);
}

export function useOpenTuiKeyboard(handler: (event: OpenTuiKeyEvent) => void): void {
  useKeyboard((event) => {
    handler(event as OpenTuiKeyEvent);
  });
}

export function useOpenTuiTerminalDimensions(): { width: number; height: number } {
  return useTerminalDimensions();
}

function parseTerminalColor(
  input: string,
): { red: number; green: number; blue: number } | undefined {
  if (input.startsWith("rgb:")) {
    const parts = input.slice(4).split("/");
    if (parts.length !== 3) {
      return undefined;
    }
    const [redPart, greenPart, bluePart] = parts;
    if (!redPart || !greenPart || !bluePart) {
      return undefined;
    }
    const red = Number.parseInt(redPart, 16) >> 8;
    const green = Number.parseInt(greenPart, 16) >> 8;
    const blue = Number.parseInt(bluePart, 16) >> 8;
    if ([red, green, blue].some((value) => Number.isNaN(value))) {
      return undefined;
    }
    return { red, green, blue };
  }

  if (/^#[0-9a-f]{6}$/iu.test(input)) {
    return {
      red: Number.parseInt(input.slice(1, 3), 16),
      green: Number.parseInt(input.slice(3, 5), 16),
      blue: Number.parseInt(input.slice(5, 7), 16),
    };
  }

  const rgbMatch = /^rgb\((\d+),(\d+),(\d+)\)$/u.exec(input.replace(/\s+/gu, ""));
  if (!rgbMatch) {
    return undefined;
  }
  const [, redPart, greenPart, bluePart] = rgbMatch;
  if (!redPart || !greenPart || !bluePart) {
    return undefined;
  }
  const red = Number.parseInt(redPart, 10);
  const green = Number.parseInt(greenPart, 10);
  const blue = Number.parseInt(bluePart, 10);
  if ([red, green, blue].some((value) => Number.isNaN(value))) {
    return undefined;
  }
  return { red, green, blue };
}

function terminalBackgroundModeFromColor(
  color: { red: number; green: number; blue: number } | undefined,
): OpenTuiTerminalBackgroundMode {
  if (!color) {
    return "dark";
  }
  const luminance = (0.299 * color.red + 0.587 * color.green + 0.114 * color.blue) / 255;
  return luminance >= 0.5 ? "light" : "dark";
}

export async function getOpenTuiTerminalBackgroundMode(): Promise<OpenTuiTerminalBackgroundMode> {
  if (!process.stdin.isTTY) {
    return "dark";
  }

  return await new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", onData);
      if (timeout) {
        clearTimeout(timeout);
      }
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      const prefix = "\x1b]11;";
      const start = text.indexOf(prefix);
      if (start < 0) {
        return;
      }
      const remainder = text.slice(start + prefix.length);
      const belIndex = remainder.indexOf("\u0007");
      const stIndex = remainder.indexOf("\u001b\\");
      const endIndexCandidates = [belIndex, stIndex].filter((index) => index >= 0);
      const endIndex =
        endIndexCandidates.length > 0 ? Math.min(...endIndexCandidates) : remainder.length;
      const value = remainder.slice(0, endIndex);
      if (value.length === 0) {
        return;
      }
      cleanup();
      resolve(terminalBackgroundModeFromColor(parseTerminalColor(value)));
    };

    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
    process.stdout.write("\x1b]11;?\x07");
    timeout = setTimeout(() => {
      cleanup();
      resolve("dark");
    }, 250);
  });
}

export function createOpenTuiElement(
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
): React.ReactNode {
  return createElement(
    type as Parameters<typeof createElement>[0],
    props as Parameters<typeof createElement>[1],
    ...(children as React.ReactNode[]),
  );
}

export async function openTuiAct(callback: () => void | Promise<void>): Promise<void> {
  await act(callback);
}

export async function openTuiTestRender(
  node: React.ReactNode,
  options: OpenTuiTestRenderOptions,
): Promise<OpenTuiTestRenderSetup> {
  return await testRender(node, options);
}

export function createOpenTuiSolidElement(
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
): OpenTuiSolidNode {
  return () => {
    if (typeof type === "function") {
      return (type as (props: Record<string, unknown>) => unknown)({
        ...props,
        children,
      });
    }
    return (createSolidElement as (...args: unknown[]) => unknown)(type, props, ...children);
  };
}

export async function openTuiSolidAct(callback: () => void | Promise<void>): Promise<void> {
  await callback();
}

export async function openTuiSolidTestRender(
  node: OpenTuiSolidNode,
  options: OpenTuiTestRenderOptions,
): Promise<OpenTuiTestRenderSetup> {
  return await solidTestRender(node, options);
}

export async function runOpenTuiSmoke(
  options: OpenTuiSmokeOptions = {},
): Promise<OpenTuiSmokeResult> {
  const screenMode = options.screenMode ?? DEFAULT_SCREEN_MODE;
  const renderer = await createCliRenderer(
    createCliRendererConfig({
      testing: true,
      screenMode,
    }),
  );
  const root = createRoot(renderer);

  try {
    root.render(
      React.createElement(
        "box",
        { style: { padding: 1, flexDirection: "column" } },
        React.createElement("text", {
          content: options.label ?? "Brewva OpenTUI smoke",
          style: { fg: "#8ab4f8" },
        }),
      ),
    );
    renderer.requestRender();
    await new Promise((resolve) => setTimeout(resolve, 16));
  } finally {
    root.unmount();
    renderer.destroy();
  }

  return {
    backend: "opentui",
    label: options.label,
    screenMode,
  };
}

export type {
  OpenTuiKeyEvent,
  OpenTuiRenderer,
  OpenTuiRoot,
  OpenTuiScrollBoxHandle,
  OpenTuiTextareaHandle,
};
