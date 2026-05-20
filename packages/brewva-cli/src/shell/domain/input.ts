import type { ShellEffect } from "./effects.js";
import type { CliShellPromptPart } from "./prompt.js";

export interface ShellKeyboardInput {
  readonly type?: "keyboard";
  key: string;
  text?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export type ShellInput =
  | ShellKeyboardInput
  | {
      readonly type: "viewport.resize";
      readonly columns: number;
      readonly rows: number;
    }
  | {
      readonly type: "composer.editorSync";
      readonly text: string;
      readonly cursor: number;
      readonly parts?: readonly CliShellPromptPart[];
    }
  | {
      readonly type: "keymap.command";
      readonly commandId: string;
      readonly source: "keybinding";
    }
  | {
      readonly type: "keymap.effect";
      readonly effect: ShellEffect;
    }
  | {
      readonly type: "completion.select";
      readonly index: number;
    }
  | {
      readonly type: "completion.accept";
    }
  | {
      readonly type: "transcript.scrollSync";
      readonly followMode: "live" | "scrolled";
      readonly scrollOffset: number;
    }
  | {
      readonly type: "transcript.navigationAck";
      readonly requestId: number;
    }
  | {
      readonly type: "session.open";
      readonly sessionId: string;
    };

export type CliShellInput = ShellKeyboardInput;

export function isShellKeyboardInput(input: ShellInput): input is ShellKeyboardInput {
  return input.type === undefined || input.type === "keyboard";
}
