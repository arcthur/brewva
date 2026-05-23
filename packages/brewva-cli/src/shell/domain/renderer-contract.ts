import type { SessionWireFrame } from "@brewva/brewva-runtime/protocol";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { ShellInput } from "./input.js";
import type { BrewvaResolvedKeymapBindings, BrewvaTuiConfig } from "./tui.js";
import type { ShellViewModel } from "./view-model.js";

export interface ShellRendererNotifier {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ShellRendererController {
  readonly ui: ShellRendererNotifier;
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
  subscribe(listener: () => void): () => void;
  wantsInput(input: ShellInput): boolean;
  handleInput(input: ShellInput): Promise<boolean>;
}
