declare const brewvaIdentifierBrand: unique symbol;

export type BrewvaIdentifier<TName extends string> = string & {
  readonly [brewvaIdentifierBrand]: TName;
};

export type BrewvaToolCallId = BrewvaIdentifier<"BrewvaToolCallId">;
export type BrewvaIntentId = BrewvaIdentifier<"BrewvaIntentId">;
export type BrewvaWalId = BrewvaIdentifier<"BrewvaWalId">;
export type BrewvaToolName = BrewvaIdentifier<"BrewvaToolName">;
export type BrewvaSessionId = BrewvaIdentifier<"BrewvaSessionId">;

export function asBrewvaToolCallId(value: string): BrewvaToolCallId {
  return value as BrewvaToolCallId;
}

export function asBrewvaIntentId(value: string): BrewvaIntentId {
  return value as BrewvaIntentId;
}

export function asBrewvaWalId(value: string): BrewvaWalId {
  return value as BrewvaWalId;
}

export function asBrewvaToolName(value: string): BrewvaToolName {
  return value as BrewvaToolName;
}

export function asBrewvaSessionId(value: string): BrewvaSessionId {
  return value as BrewvaSessionId;
}
