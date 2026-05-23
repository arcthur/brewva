import type { ShellEffect } from "./effects.js";

export type BrewvaShortcutValue = string | readonly string[] | undefined;

export type BrewvaKeymapLayer =
  | "global"
  | "composer"
  | "completion"
  | "overlay"
  | "pager"
  | "subagentFooter"
  | "selection";

export interface BrewvaKeymapBindingDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly layer?: BrewvaKeymapLayer;
  readonly shortcuts: readonly string[];
  readonly effect?: ShellEffect;
  readonly internal?: boolean;
}

export interface BrewvaResolvedKeymapBindings {
  readonly definitions: readonly BrewvaKeymapBindingDefinition[];
  get(id: string): readonly string[];
  getDefinition(id: string): BrewvaKeymapBindingDefinition | undefined;
  ids(): readonly string[];
  has(id: string): boolean;
}

export interface BrewvaTuiLargePasteThreshold {
  readonly minLines: number;
  readonly minCharacters: number;
}

export interface BrewvaTuiScrollAcceleration {
  readonly type?: "linear" | "exponential";
  readonly speed?: number;
}

export interface BrewvaTuiConfig {
  readonly theme: string;
  readonly keymap: {
    readonly leader: string;
    readonly leaderTimeoutMs: number;
    readonly bindings: Readonly<Record<string, BrewvaShortcutValue>>;
  };
  readonly view: {
    readonly showThinking: boolean;
    readonly toolDetails: boolean;
    readonly diff: {
      readonly style: "auto" | "stacked";
      readonly wrapMode: "word" | "none";
    };
  };
  readonly input: {
    readonly largePasteThreshold: BrewvaTuiLargePasteThreshold;
  };
  readonly scroll: {
    readonly acceleration: BrewvaTuiScrollAcceleration;
  };
}
