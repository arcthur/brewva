import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { ShellInput } from "./input.js";
import type { ShellViewModel } from "./view-model.js";

export interface ShellRendererNotifier {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ShellRendererController {
  readonly ui: ShellRendererNotifier;
  getViewState(): ShellViewModel;
  getToolDefinitions(): ReadonlyMap<string, BrewvaToolDefinition>;
  getSessionIdentity(): {
    sessionId: string;
    lineageLabel: string | null;
    modelLabel: string;
    thinkingLevel: string;
  };
  subscribe(listener: () => void): () => void;
  wantsInput(input: ShellInput): boolean;
  handleInput(input: ShellInput): Promise<boolean>;
}
