import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import type { ShellEffect } from "./effects.js";
import type { CliShellInput } from "./input.js";

export type ShellIntent =
  | { type: "input.received"; input: CliShellInput }
  | {
      type: "prompt.submit";
      text: string;
      source: "slash" | "internal";
      warnings?: readonly string[];
    }
  | { type: "effect.dispatch"; effect: ShellEffect }
  | { type: "dialog.input"; input: CliShellInput }
  | { type: "question.input"; input: CliShellInput }
  | { type: "picker.input"; input: CliShellInput }
  | { type: "overlay.input"; input: CliShellInput }
  | { type: "promptHistory.navigate"; direction: -1 | 1 }
  | {
      type: "command.invoke";
      commandId: string;
      args: string;
      source: "keybinding" | "palette" | "slash" | "internal";
    }
  | { type: "session.event"; event: BrewvaPromptSessionEvent }
  | { type: "operator.refresh" };
