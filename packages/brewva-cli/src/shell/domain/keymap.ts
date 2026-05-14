import type { KeybindingDefinition } from "../../internal/tui/index.js";
import type { ShellEffect } from "./effects.js";

const SHELL_ACTION_PREFIX = "shell:";

const key = (
  value: string,
  modifiers: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {},
) => ({
  key: value,
  ctrl: modifiers.ctrl === true,
  meta: modifiers.meta === true,
  shift: modifiers.shift === true,
});

export const shellBuiltInKeybindings: readonly KeybindingDefinition[] = [
  {
    id: "global.scrollUp",
    context: "global",
    trigger: key("pageup"),
    action: "shell:transcript.pageUp",
  },
  {
    id: "global.scrollDown",
    context: "global",
    trigger: key("pagedown"),
    action: "shell:transcript.pageDown",
  },
  {
    id: "global.scrollTop",
    context: "global",
    trigger: key("home"),
    action: "shell:transcript.top",
  },
  {
    id: "global.scrollBottom",
    context: "global",
    trigger: key("end"),
    action: "shell:transcript.bottom",
  },
  {
    id: "composer.submit",
    context: "composer",
    trigger: key("enter"),
    action: "shell:composer.submit",
  },
  {
    id: "composer.newline",
    context: "composer",
    trigger: key("j", { ctrl: true }),
    action: "shell:composer.newline",
  },
  {
    id: "completion.accept",
    context: "completion",
    trigger: key("tab"),
    action: "shell:completion.accept",
  },
  {
    id: "completion.acceptEnter",
    context: "completion",
    trigger: key("enter"),
    action: "shell:completion.submit",
  },
  {
    id: "completion.next",
    context: "completion",
    trigger: key("down"),
    action: "shell:completion.next",
  },
  {
    id: "completion.nextCtrlN",
    context: "completion",
    trigger: key("n", { ctrl: true }),
    action: "shell:completion.next",
  },
  {
    id: "completion.prev",
    context: "completion",
    trigger: key("up"),
    action: "shell:completion.previous",
  },
  {
    id: "completion.prevCtrlP",
    context: "completion",
    trigger: key("p", { ctrl: true }),
    action: "shell:completion.previous",
  },
  {
    id: "completion.dismiss",
    context: "completion",
    trigger: key("escape"),
    action: "shell:completion.dismiss",
  },
  {
    id: "overlay.close",
    context: "overlay",
    trigger: key("escape"),
    action: "shell:overlay.close",
  },
  {
    id: "overlay.select",
    context: "overlay",
    trigger: key("enter"),
    action: "shell:overlay.primary",
  },
  {
    id: "overlay.next",
    context: "overlay",
    trigger: key("down"),
    action: "shell:overlay.next",
  },
  {
    id: "overlay.nextCtrlN",
    context: "overlay",
    trigger: key("n", { ctrl: true }),
    action: "shell:overlay.next",
  },
  {
    id: "overlay.prev",
    context: "overlay",
    trigger: key("up"),
    action: "shell:overlay.previous",
  },
  {
    id: "overlay.prevCtrlP",
    context: "overlay",
    trigger: key("p", { ctrl: true }),
    action: "shell:overlay.previous",
  },
  {
    id: "overlay.pageDown",
    context: "overlay",
    trigger: key("pagedown"),
    action: "shell:overlay.pageDown",
  },
  {
    id: "overlay.pageUp",
    context: "overlay",
    trigger: key("pageup"),
    action: "shell:overlay.pageUp",
  },
  {
    id: "overlay.fullscreen",
    context: "overlay",
    trigger: key("f", { ctrl: true }),
    action: "shell:overlay.fullscreen",
  },
  {
    id: "pager.external",
    context: "pager",
    trigger: key("e", { ctrl: true }),
    action: "shell:pager.external",
  },
];

export function decodeShellKeybindingEffect(action: string): ShellEffect | undefined {
  if (action.startsWith("command:")) {
    return {
      type: "command.invokeById",
      commandId: action.slice("command:".length),
      source: "keybinding",
    };
  }
  if (!action.startsWith(SHELL_ACTION_PREFIX)) {
    return undefined;
  }
  const semantic = action.slice(SHELL_ACTION_PREFIX.length);
  switch (semantic) {
    case "composer.submit":
    case "completion.accept":
    case "completion.submit":
    case "completion.dismiss":
    case "overlay.primary":
      return { type: semantic };
    case "composer.newline":
      return { type: "composer.insertNewline" };
    case "completion.next":
      return { type: "completion.move", delta: 1 };
    case "completion.previous":
      return { type: "completion.move", delta: -1 };
    case "overlay.close":
      return { type: "overlay.closeActive", cancelled: true };
    case "overlay.next":
      return { type: "overlay.moveSelection", delta: 1 };
    case "overlay.previous":
      return { type: "overlay.moveSelection", delta: -1 };
    case "overlay.pageDown":
      return { type: "overlay.scrollPage", direction: 1 };
    case "overlay.pageUp":
      return { type: "overlay.scrollPage", direction: -1 };
    case "overlay.fullscreen":
      return { type: "overlay.toggleFullscreen" };
    case "pager.external":
      return { type: "pager.externalActive" };
    case "transcript.pageUp":
      return { type: "transcript.navigate", kind: "pageUp" };
    case "transcript.pageDown":
      return { type: "transcript.navigate", kind: "pageDown" };
    case "transcript.top":
      return { type: "transcript.navigate", kind: "top" };
    case "transcript.bottom":
      return { type: "transcript.navigate", kind: "bottom" };
    default:
      return undefined;
  }
}

export function normalizeShellInputKey(inputKey: string): string {
  switch (inputKey.toLowerCase()) {
    case "return":
    case "linefeed":
      return "enter";
    case "arrowup":
    case "uparrow":
      return "up";
    case "arrowdown":
    case "downarrow":
      return "down";
    case "arrowleft":
    case "leftarrow":
      return "left";
    case "arrowright":
    case "rightarrow":
      return "right";
    case "pageup":
    case "page-up":
      return "pageup";
    case "pagedown":
    case "page-down":
      return "pagedown";
    default:
      return inputKey.toLowerCase();
  }
}
