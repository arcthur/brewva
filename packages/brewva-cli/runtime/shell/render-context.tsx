import { createContext, useContext, type Accessor, type JSX } from "solid-js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import type { ScrollAcceleration } from "../opentui/index.js";
import type { ShellDiffStyle, ShellDiffWrapMode } from "./diff-view.js";
import { createScrollAcceleration } from "./palette.js";

export interface ShellRenderContextValue {
  runtime: ShellRendererController;
  diffStyle: Accessor<ShellDiffStyle>;
  diffWrapMode: Accessor<ShellDiffWrapMode>;
  showThinking: Accessor<boolean>;
  scrollAcceleration: Accessor<ScrollAcceleration>;
}

const ShellRenderContext = createContext<ShellRenderContextValue>();

export function ShellRenderProvider(input: {
  value: ShellRenderContextValue;
  children: JSX.Element;
}): JSX.Element {
  return ShellRenderContext.Provider({
    value: input.value,
    get children() {
      return input.children;
    },
  });
}

/**
 * Build a ShellRenderContextValue from a live runtime. Used by both the
 * per-message settled path (SplitFooterScrollbackWriter.syncSettled) and the
 * batch scrollback path (TranscriptScrollbackDocument), so both render
 * identically.
 */
export function buildShellRenderContext(runtime: ShellRendererController): ShellRenderContextValue {
  const viewState = runtime.getViewState();
  return {
    runtime,
    diffStyle: () => viewState.diff.style,
    diffWrapMode: () => viewState.diff.wrapMode,
    showThinking: () => viewState.view.showThinking,
    scrollAcceleration: () => createScrollAcceleration(runtime.getTuiConfig().scroll.acceleration),
  };
}

export function useShellRenderContext(): ShellRenderContextValue {
  const context = useContext(ShellRenderContext);
  if (!context) {
    throw new Error("Shell render context is not available.");
  }
  return context;
}
