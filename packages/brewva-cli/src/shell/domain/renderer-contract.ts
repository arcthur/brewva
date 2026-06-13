import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { ShellInput } from "./input.js";
import type { BrewvaResolvedKeymapBindings, BrewvaTuiConfig } from "./tui.js";
import type { ShellViewModel } from "./view-model.js";

export interface ShellRendererNotifier {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ShellRendererController {
  readonly ui: ShellRendererNotifier;
  /**
   * Project the current view model. The result is a structurally shared
   * snapshot: it is stable until the next commit, and unchanged branches
   * are reused across calls. Consumers must not mutate it and must not
   * hold it across awaits while the shell keeps running — copy what they
   * need first.
   */
  getViewState(): ShellViewModel;
  getSessionWireFrames(sessionId: string): readonly SessionWireFrame[];
  getToolDefinitions(): ReadonlyMap<string, BrewvaToolDefinition>;
  getTuiConfig(): BrewvaTuiConfig;
  getKeymapBindings(): BrewvaResolvedKeymapBindings;
  getShortcutLabel(id: string): string | undefined;
  getSessionIdentity(): {
    sessionId: string;
    assistantLabel: string;
    lineageLabel: string | null;
    modelLabel: string;
    thinkingLevel: string;
  };
  requestRender(): void;
  submitComposer(): void;
  subscribe(listener: () => void): () => void;
  wantsInput(input: ShellInput): boolean;
  handleInput(input: ShellInput): Promise<boolean>;
}
