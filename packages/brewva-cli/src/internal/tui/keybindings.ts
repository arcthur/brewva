import type { KeybindingTrigger } from "./input.js";

export type KeybindingContext =
  | "global"
  | "composer"
  | "completion"
  | "overlay"
  | "pager"
  | "transcript"
  | (string & {});

export interface KeybindingDefinition {
  id: string;
  context: KeybindingContext;
  trigger: KeybindingTrigger;
  action: string;
  priority?: number;
}

function sameTrigger(left: KeybindingTrigger, right: KeybindingTrigger): boolean {
  return (
    left.key === right.key &&
    left.ctrl === right.ctrl &&
    left.meta === right.meta &&
    left.shift === right.shift
  );
}

export interface KeybindingResolver {
  resolve(
    contextChain: readonly KeybindingContext[],
    trigger: KeybindingTrigger,
  ): KeybindingDefinition | undefined;
  list(context?: KeybindingContext): KeybindingDefinition[];
}

export function createKeybindingResolver(
  bindings: readonly KeybindingDefinition[],
): KeybindingResolver {
  const normalized = [...bindings].toSorted(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id),
  );

  return {
    resolve(contextChain, trigger) {
      for (const context of contextChain) {
        const match = normalized.find(
          (binding) => binding.context === context && sameTrigger(binding.trigger, trigger),
        );
        if (match) {
          return match;
        }
      }
      return undefined;
    },
    list(context) {
      return typeof context === "string"
        ? normalized.filter((binding) => binding.context === context)
        : [...normalized];
    },
  };
}
