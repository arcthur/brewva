import type { JsonValue } from "@brewva/brewva-std/json";

export type { JsonValue };

export type JsonPrimitive = string | number | boolean | null;
export type JsonRecord = { readonly [key: string]: JsonValue };
export interface ProtocolRecord {
  readonly [key: string]: unknown;
}
