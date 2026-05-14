import type { KeybindingContext, KeybindingResolver } from "@brewva/brewva-tui";
import type { CliShellInput } from "./input.js";
import type { ShellIntent } from "./intent.js";
import { decodeShellKeybindingEffect, normalizeShellInputKey } from "./keymap.js";
import type { CliShellOverlayPayload } from "./overlays/payloads.js";

export interface ShellInputRouterState {
  activeOverlayKind?: CliShellOverlayPayload["kind"];
  hasCompletion: boolean;
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

export function shellInputContexts(state: {
  activeOverlayKind?: CliShellOverlayPayload["kind"];
  hasCompletion: boolean;
}): KeybindingContext[] {
  if (state.activeOverlayKind === "pager") {
    return ["pager", "overlay", "global"];
  }
  if (state.activeOverlayKind) {
    return ["overlay", "global"];
  }
  if (state.hasCompletion) {
    return ["completion", "composer", "global"];
  }
  return ["composer", "global"];
}

function isPickerOverlay(kind: CliShellOverlayPayload["kind"] | undefined): boolean {
  return kind === "commandPalette" || kind === "modelPicker" || kind === "providerPicker";
}

/** Question overlay: route everything except ctrl+meta combos; allow ^n/^p (shift allowed, flow remaps). */
function questionOverlayAcceptsShellInput(shellInput: CliShellInput): boolean {
  if (shellInput.meta) {
    return false;
  }
  if (!shellInput.ctrl) {
    return true;
  }
  const k = normalizeShellInputKey(shellInput.key);
  return k === "n" || k === "p";
}

export function routeShellInput(input: {
  input: CliShellInput;
  state: ShellInputRouterState;
  keybindings: KeybindingResolver;
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

  const binding = input.keybindings.resolve(shellInputContexts(input.state), {
    key: normalizeShellInputKey(input.input.key),
    ctrl: input.input.ctrl,
    meta: input.input.meta,
    shift: input.input.shift,
  });
  if (binding) {
    const effect = decodeShellKeybindingEffect(binding.action);
    return {
      handled: true,
      ...(effect ? { intent: { type: "effect.dispatch", effect } } : {}),
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

  const key = normalizeShellInputKey(input.input.key);
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
