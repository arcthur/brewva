import {
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_UTILITY_OBSERVED_EVENT_TYPE,
} from "@brewva/brewva-runtime/protocol";
import {
  RECALL_CURATION_HALFLIFE_DAYS,
  type RecallCurationAggregate,
  type RecallCurationSnapshot,
} from "../types.js";
import { isRecord, type RecallBrokerRuntime } from "./runtime-port.js";
import { readString, readStringArray } from "./text.js";

const RECALL_CURATION_HALFLIFE_MS = RECALL_CURATION_HALFLIFE_DAYS * 24 * 60 * 60 * 1000;

export const RECALL_STATE_INVALIDATING_EVENT_TYPES = new Set<string>([
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_UTILITY_OBSERVED_EVENT_TYPE,
]);

function createEmptyCurationAggregate(stableId: string): RecallCurationAggregate {
  return {
    stableId,
    helpfulSignals: 0,
    staleSignals: 0,
    supersededSignals: 0,
    wrongScopeSignals: 0,
    misleadingSignals: 0,
    helpfulWeight: 0,
    staleWeight: 0,
    supersededWeight: 0,
    wrongScopeWeight: 0,
    misleadingWeight: 0,
    lastSignalAt: undefined,
  };
}

function curationSignalWeight(timestamp: number | undefined, now = Date.now()): number {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return 1;
  }
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs === 0) {
    return 1;
  }
  return Math.pow(0.5, ageMs / RECALL_CURATION_HALFLIFE_MS);
}

function readCurationSignal(payload: Record<string, unknown>): RecallCurationAggregate[] {
  const signal = readString(payload.signal);
  const stableIds = readStringArray(payload.stableIds);
  const timestamp =
    typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)
      ? payload.timestamp
      : undefined;
  const weight = curationSignalWeight(timestamp);
  if (!signal || stableIds.length === 0) {
    return [];
  }
  return stableIds.map((stableId) => {
    const entry = createEmptyCurationAggregate(stableId);
    entry.lastSignalAt = timestamp;
    switch (signal) {
      case "helpful":
        entry.helpfulSignals = 1;
        entry.helpfulWeight = weight;
        return entry;
      case "stale":
        entry.staleSignals = 1;
        entry.staleWeight = weight;
        return entry;
      case "superseded":
        entry.supersededSignals = 1;
        entry.supersededWeight = weight;
        return entry;
      case "wrong_scope":
        entry.wrongScopeSignals = 1;
        entry.wrongScopeWeight = weight;
        return entry;
      case "misleading":
        entry.misleadingSignals = 1;
        entry.misleadingWeight = weight;
        return entry;
      default:
        return entry;
    }
  });
}

export function buildCurationAggregates(runtime: RecallBrokerRuntime): RecallCurationAggregate[] {
  const byStableId = new Map<string, RecallCurationAggregate>();
  for (const sessionId of runtime.events.records.listSessionIds()) {
    for (const event of runtime.events.records.list(sessionId)) {
      if (!RECALL_STATE_INVALIDATING_EVENT_TYPES.has(event.type)) {
        continue;
      }
      if (!isRecord(event.payload)) continue;
      for (const entry of readCurationSignal({
        ...event.payload,
        timestamp: event.timestamp,
      })) {
        const current =
          byStableId.get(entry.stableId) ?? createEmptyCurationAggregate(entry.stableId);
        current.helpfulSignals += entry.helpfulSignals;
        current.staleSignals += entry.staleSignals;
        current.supersededSignals += entry.supersededSignals;
        current.wrongScopeSignals += entry.wrongScopeSignals;
        current.misleadingSignals += entry.misleadingSignals;
        current.helpfulWeight += entry.helpfulWeight;
        current.staleWeight += entry.staleWeight;
        current.supersededWeight += entry.supersededWeight;
        current.wrongScopeWeight += entry.wrongScopeWeight;
        current.misleadingWeight += entry.misleadingWeight;
        current.lastSignalAt = Math.max(current.lastSignalAt ?? 0, entry.lastSignalAt ?? 0);
        byStableId.set(entry.stableId, current);
      }
    }
  }
  return [...byStableId.values()].toSorted((left, right) =>
    left.stableId.localeCompare(right.stableId),
  );
}

export function curationAdjustment(curation: RecallCurationAggregate | undefined): number {
  if (!curation) return 0;
  return (
    Math.min(0.18, curation.helpfulWeight * 0.04) -
    Math.min(0.12, curation.staleWeight * 0.03) -
    Math.min(0.2, curation.supersededWeight * 0.05) -
    Math.min(0.16, curation.wrongScopeWeight * 0.04) -
    Math.min(0.24, curation.misleadingWeight * 0.06)
  );
}

export function buildCurationSnapshot(
  curation: RecallCurationAggregate | undefined,
): RecallCurationSnapshot | undefined {
  if (!curation) {
    return undefined;
  }
  return {
    helpfulSignals: curation.helpfulSignals,
    staleSignals: curation.staleSignals,
    supersededSignals: curation.supersededSignals,
    wrongScopeSignals: curation.wrongScopeSignals,
    misleadingSignals: curation.misleadingSignals,
    helpfulWeight: curation.helpfulWeight,
    staleWeight: curation.staleWeight,
    supersededWeight: curation.supersededWeight,
    wrongScopeWeight: curation.wrongScopeWeight,
    misleadingWeight: curation.misleadingWeight,
    lastSignalAt: curation.lastSignalAt,
    scoreAdjustment: curationAdjustment(curation),
  };
}
