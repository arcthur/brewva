import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaIdentifier, BrewvaSessionId } from "../core/identifiers.js";
import type { BrewvaRegisteredEventType } from "./registry.js";

export type { BrewvaRegisteredEventType };
export type {
  SessionRewindCompletedEventPayload,
  SessionTitleRecordedPayload,
  SessionTitleView,
  SessionUncleanShutdownReconciledPayload,
} from "../domain/sessions/types.js";
export type {
  SessionTurnTransitionPayload,
  SessionTurnTransitionReason,
} from "../domain/sessions/wire.js";
export type {
  ToolCallBlockedEventPayload,
  ToolLifecycleEventPayload,
  ToolOutputDistilledEventPayload,
  ToolResultFailureClass,
  ToolResultFailureContextPayload,
  ToolResultRecordedEventPayload,
  ToolResultVerdict,
} from "../domain/tools/types.js";
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

export type BrewvaEventDurabilityClass =
  | "source_of_truth"
  | "durable_evidence"
  | "rebuildable_signal"
  | "session_local";

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
  title: string;
}

export function asBrewvaEventType(value: string): BrewvaEventType {
  return value as BrewvaEventType;
}
