import type { JsonValue } from "@brewva/brewva-std/json";

export interface CustomEventPayload {
  readonly namespace: string;
  readonly kind: string;
  readonly version: number;
  readonly authority: "none" | "advisory";
  readonly payload: JsonValue;
}

export interface AnchorCommittedPayload {
  readonly label?: string;
  readonly payload?: JsonValue;
}
