import type { JsonValue } from "../utils/json.js";

export interface BrewvaEventRecord {
  id: string;
  sessionId: string;
  type: string;
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
  | "state"
  | "other";

export interface BrewvaStructuredEvent {
  schema: "brewva.event.v1";
  id: string;
  sessionId: string;
  type: string;
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
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
}
