import type { OverlayPriority } from "@brewva/brewva-tui";
import type { ShellEffect } from "./effects.js";
import type { CliShellOverlayPayload } from "./overlays/payloads.js";
import type { CliShellAction } from "./state.js";

export type ShellAction =
  | CliShellAction
  | {
      type: "domain.sessionGeneration.increment";
    }
  | {
      type: "domain.sessionGeneration.set";
      sessionGeneration: number;
    }
  | {
      type: "overlay.openData";
      payload: CliShellOverlayPayload;
      priority?: OverlayPriority;
      suspendCurrent?: boolean;
      id?: string;
    }
  | {
      type: "overlay.replaceData";
      payload: CliShellOverlayPayload;
    };

export interface ShellCommitOptions {
  readonly refreshCompletions?: boolean;
  readonly debounceStatus?: boolean;
  readonly emitChange?: boolean;
}

export interface ShellCommitBatch {
  readonly reset?: { readonly sessionGeneration: number };
  readonly actions?: readonly ShellAction[];
}

export type ShellCommitInput = ShellAction | readonly ShellAction[] | ShellCommitBatch;

export interface ShellRuntimeResult {
  actions: readonly ShellAction[];
  effects: readonly ShellEffect[];
}
