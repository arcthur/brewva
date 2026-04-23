import { createContext, useContext, type Accessor, type JSX } from "solid-js";
import type { CliShellController } from "../../src/shell/controller.js";
import type { ShellDiffStyle, ShellDiffWrapMode } from "./diff-view.js";

export interface ShellRenderContextValue {
  controller: CliShellController;
  diffStyle: Accessor<ShellDiffStyle>;
  diffWrapMode: Accessor<ShellDiffWrapMode>;
  showThinking: Accessor<boolean>;
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

export function useShellRenderContext(): ShellRenderContextValue {
  const context = useContext(ShellRenderContext);
  if (!context) {
    throw new Error("Shell render context is not available.");
  }
  return context;
}
