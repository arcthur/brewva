import { type BrewvaEventRecord } from "@brewva/brewva-runtime/protocol";
import type { SessionIndexDigest, SessionIndexTapeEvidence } from "@brewva/brewva-session-index";
import type { RecallSessionDigest } from "../types.js";
import { compactText } from "./text.js";

export function mapSessionIndexDigest(entry: SessionIndexDigest): RecallSessionDigest {
  return {
    sessionId: entry.sessionId,
    eventCount: entry.eventCount,
    lastEventAt: entry.lastEventAt,
    repositoryRoot: entry.repositoryRoot,
    primaryRoot: entry.primaryRoot,
    targetRoots: entry.targetRoots,
    ...(entry.taskGoal ? { taskGoal: entry.taskGoal } : {}),
    digestText: entry.digestText,
  };
}

// Event-record adaptation is only for trust and strength classification; it is not an event-tape replay surface.
export function mapSessionIndexEvidenceToEvent(entry: SessionIndexTapeEvidence): BrewvaEventRecord {
  return {
    id: entry.eventId,
    sessionId: entry.sessionId,
    type: entry.type,
    timestamp: entry.timestamp,
    ...(entry.turn === undefined ? {} : { turn: entry.turn }),
    payload: entry.payload as BrewvaEventRecord["payload"],
  } as BrewvaEventRecord;
}

export function renderEventTitle(event: BrewvaEventRecord): string {
  return compactText(`${event.type} (${event.sessionId})`, 120);
}
