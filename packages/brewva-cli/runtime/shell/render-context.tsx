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
  /** "interactive" (live shell — folds are click-toggleable) vs "static" (the
   *  external `$PAGER` transcript export — folds render FULLY EXPANDED, because a
   *  "Click to expand" / "▸ Thought" hint is inert in `less` and would strand the
   *  hidden content out of the export). */
  folding: Accessor<"interactive" | "static">;
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
 * Build a ShellRenderContextValue from a live runtime. Used by the batch
 * transcript-scrollback render path (the external-pager transcript export) so it
 * renders identically to the live shell.
 */
export function buildShellRenderContext(runtime: ShellRendererController): ShellRenderContextValue {
  const viewState = runtime.getViewState();
  return {
    runtime,
    diffStyle: () => viewState.diff.style,
    diffWrapMode: () => viewState.diff.wrapMode,
    showThinking: () => viewState.view.showThinking,
    scrollAcceleration: () => createScrollAcceleration(runtime.getTuiConfig().scroll.acceleration),
    // The pager export is a static document — fully expand every fold so nothing is
    // stranded behind an inert "Click to expand" in `less`.
    folding: () => "static",
  };
}

export function useShellRenderContext(): ShellRenderContextValue {
  const context = useContext(ShellRenderContext);
  if (!context) {
    throw new Error("Shell render context is not available.");
  }
  return context;
}
