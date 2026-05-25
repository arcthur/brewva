import { optionalStringField, stringField } from "./shared.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

export interface BrewvaEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly turn?: number;
  readonly type: string;
  readonly category?: string;
  readonly timestamp: number;
  readonly isoTime?: string;
  readonly payload?: ProtocolRecord;
  readonly schema?: string;
  readonly source?: string;
  readonly [key: string]: unknown;
}

export interface BrewvaStructuredEvent extends BrewvaEventRecord {}

export interface BrewvaEventQuery {
  readonly sessionId?: string;
  readonly type?: string;
  readonly category?: string;
  readonly since?: number;
  readonly limit?: number;
  readonly after?: number;
  readonly before?: number;
  readonly offset?: number;
  readonly last?: number;
  readonly [key: string]: unknown;
}

export function payloadOf(
  inputEvent: { readonly payload?: ProtocolRecord; readonly [key: string]: unknown },
  ..._rest: readonly unknown[]
): ProtocolRecord {
  return inputEvent.payload ?? {};
}

export function makeEvent(
  type: string,
  payload: ProtocolRecord = {},
  extra: ProtocolRecord = {},
): BrewvaEventRecord {
  const timestamp = Date.now();
  return Object.freeze({
    id: stringField(extra, "id", `${type}:${timestamp}`),
    sessionId:
      optionalStringField(extra, "sessionId") ??
      optionalStringField(payload, "sessionId") ??
      "default",
    type,
    payload,
    timestamp,
    isoTime: new Date(timestamp).toISOString(),
    ...extra,
  });
}
