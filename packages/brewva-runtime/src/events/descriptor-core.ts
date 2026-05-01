import type {
  BrewvaEventCategory,
  BrewvaEventDurabilityClass,
  BrewvaEventRecord,
} from "./types.js";

export type BrewvaEventLike = {
  type: string;
  payload?: unknown;
  timestamp?: unknown;
};

export interface BrewvaEventDescriptor<TType extends string, TPayload> {
  readonly type: TType;
  readonly durability: BrewvaEventDurabilityClass;
  readonly category: BrewvaEventCategory;
  readonly readPayload: (payload: unknown) => TPayload | null;
}

export type BrewvaEventDescriptorPayload<
  TDescriptor extends BrewvaEventDescriptor<string, unknown>,
> = TDescriptor extends BrewvaEventDescriptor<string, infer TPayload> ? TPayload : never;

export type BrewvaTypedEventRecord<TDescriptor extends BrewvaEventDescriptor<string, unknown>> =
  Omit<BrewvaEventRecord, "type" | "payload"> & {
    type: TDescriptor["type"];
    payload: BrewvaEventDescriptorPayload<TDescriptor>;
  };

export function defineBrewvaEventDescriptor<TType extends string, TPayload>(input: {
  type: TType;
  category: BrewvaEventCategory;
  durability: BrewvaEventDurabilityClass;
  readPayload: (payload: unknown) => TPayload | null;
}): BrewvaEventDescriptor<TType, TPayload> {
  return Object.freeze(input);
}

export function readBrewvaEventPayload<TDescriptor extends BrewvaEventDescriptor<string, unknown>>(
  event: BrewvaEventLike,
  descriptor: TDescriptor,
): BrewvaEventDescriptorPayload<TDescriptor> | null {
  if (event.type !== descriptor.type) {
    return null;
  }
  return descriptor.readPayload(event.payload) as BrewvaEventDescriptorPayload<TDescriptor> | null;
}

export function asTypedBrewvaEventRecord<
  TDescriptor extends BrewvaEventDescriptor<string, unknown>,
>(event: BrewvaEventRecord, descriptor: TDescriptor): BrewvaTypedEventRecord<TDescriptor> | null {
  const payload = readBrewvaEventPayload(event, descriptor);
  if (payload === null) {
    return null;
  }
  return {
    ...event,
    type: descriptor.type,
    payload,
  };
}
