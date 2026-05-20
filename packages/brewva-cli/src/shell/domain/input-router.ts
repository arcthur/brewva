import type { CliShellInput } from "./input.js";
import type { ShellIntent } from "./intent.js";
import { normalizeShellInputTrigger } from "./keymap.js";
import type { CliShellOverlayPayload } from "./overlays/payloads.js";

export interface ShellInputRouterState {
  activeOverlayKind?: CliShellOverlayPayload["kind"];
  hasCompletion: boolean;
  isStreaming: boolean;
  canNavigatePromptHistoryPrevious: boolean;
  canNavigatePromptHistoryNext: boolean;
}

export type ShellInputRoute =
  | {
      handled: false;
    }
  | {
      handled: true;
      intent?: ShellIntent;
    };

function isPickerOverlay(kind: CliShellOverlayPayload["kind"] | undefined): boolean {
  return kind === "commandPalette" || kind === "modelPicker" || kind === "providerPicker";
}

/** Question overlay: route everything except ctrl+meta combos; allow ^n/^p (shift allowed, flow remaps). */
function questionOverlayAcceptsShellInput(shellInput: CliShellInput): boolean {
  const trigger = normalizeShellInputTrigger(shellInput);
  if (trigger.meta) {
    return false;
  }
  if (!trigger.ctrl) {
    return true;
  }
  const k = trigger.key;
  return k === "n" || k === "p";
}

export function routeShellInput(input: {
  input: CliShellInput;
  state: ShellInputRouterState;
}): ShellInputRoute {
  const overlayKind = input.state.activeOverlayKind;
  if (overlayKind === "input") {
    return {
      handled: true,
      intent: { type: "dialog.input", input: input.input },
    };
  }
  if (overlayKind === "question" && questionOverlayAcceptsShellInput(input.input)) {
    return {
      handled: true,
      intent: { type: "question.input", input: input.input },
    };
  }

  const normalizedTrigger = normalizeShellInputTrigger(input.input);
  const key = normalizedTrigger.key;
  if (!overlayKind && !input.state.hasCompletion && key === "escape" && input.state.isStreaming) {
    return {
      handled: true,
      intent: {
        type: "effect.dispatch",
        effect: { type: "session.abort", notification: "Aborted the current turn." },
      },
    };
  }

  if (isPickerOverlay(overlayKind)) {
    return {
      handled: true,
      intent: { type: "picker.input", input: input.input },
    };
  }
  if (overlayKind) {
    return {
      handled: true,
      intent: { type: "overlay.input", input: input.input },
    };
  }

  if (key === "up" && input.state.canNavigatePromptHistoryPrevious) {
    return {
      handled: true,
      intent: { type: "promptHistory.navigate", direction: -1 },
    };
  }
  if (key === "down" && input.state.canNavigatePromptHistoryNext) {
    return {
      handled: true,
      intent: { type: "promptHistory.navigate", direction: 1 },
    };
  }

  return { handled: false };
}
