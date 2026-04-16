import type { BrewvaRegisteredEventType } from "../events/event-types.js";
import type { JsonValue } from "../utils/json.js";
import type { BrewvaIdentifier, BrewvaSessionId } from "./identifiers.js";

export type { BrewvaRegisteredEventType };
export type BrewvaEventType = BrewvaRegisteredEventType | BrewvaIdentifier<"BrewvaCustomEventType">;

export interface BrewvaEventRecord {
  id: string;
  sessionId: BrewvaSessionId;
  type: BrewvaEventType;
  timestamp: number;
  turn?: number;
  payload?: Record<string, JsonValue>;
}

export type BrewvaEventCategory =
  | "session"
  | "turn"
  | "tool"
  | "context"
  | "cost"
  | "verification"
  | "governance"
  | "control"
  | "state"
  | "other";

export interface BrewvaStructuredEvent {
  schema: "brewva.event.v1";
  id: string;
  sessionId: BrewvaSessionId;
  type: BrewvaEventType;
  category: BrewvaEventCategory;
  timestamp: number;
  isoTime: string;
  turn?: number;
  payload?: Record<string, JsonValue>;
}

export interface BrewvaEventQuery {
  type?: string;
  last?: number;
  after?: number;
  before?: number;
  offset?: number;
  limit?: number;
}

export interface BrewvaReplaySession {
  sessionId: BrewvaSessionId;
  eventCount: number;
  lastEventAt: number;
}

export function asBrewvaEventType(value: string): BrewvaEventType {
  return value as BrewvaEventType;
}
