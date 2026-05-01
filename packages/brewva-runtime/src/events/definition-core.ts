import type { BrewvaEventCategory, BrewvaEventDurabilityClass } from "./types.js";

export interface BrewvaUntypedEventDefinition<TType extends string = string> {
  readonly type: TType;
  readonly category: BrewvaEventCategory;
  readonly durability: BrewvaEventDurabilityClass;
}

export function defineBrewvaUntypedEventDefinition<TType extends string>(input: {
  type: TType;
  category: BrewvaEventCategory;
  durability: BrewvaEventDurabilityClass;
}): BrewvaUntypedEventDefinition<TType> {
  return Object.freeze(input);
}
