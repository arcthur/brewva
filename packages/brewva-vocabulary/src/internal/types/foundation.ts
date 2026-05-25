export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];
export type JsonRecord = { readonly [key: string]: JsonValue };
export interface ProtocolRecord {
  readonly [key: string]: unknown;
}
