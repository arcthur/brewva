import {
  extractRcrContentPath,
  resolveRcrReferenceAgainst,
  type RcrEventRef,
  type RcrReference,
} from "@brewva/brewva-vocabulary/rcr";
import {
  listRuntimeWorkbenchEntries,
  queryRuntimeEvents,
  type HostedRuntimeAdapterPort,
} from "../session/runtime-ports.js";

export type WorkbenchRefOutcome = "resolved" | "broken" | "unverifiable";
export type WorkbenchEntryStaleness = "fresh" | "stale" | "unverifiable";

/**
 * Aggregate per-anchor resolution outcomes into a single entry verdict. A note is
 * `fresh` when at least one anchor still resolves, `stale` when every verifiable
 * anchor is broken, and `unverifiable` when no anchor could be checked. It never
 * reports a false `fresh`: a `broken` anchor outranks an `unverifiable` one.
 */
export function aggregateWorkbenchEntryStaleness(
  outcomes: readonly WorkbenchRefOutcome[],
): WorkbenchEntryStaleness {
  let sawBroken = false;
  for (const outcome of outcomes) {
    if (outcome === "resolved") return "fresh";
    if (outcome === "broken") sawBroken = true;
  }
  return sawBroken ? "stale" : "unverifiable";
}

/**
 * Tape-derived staleness verdict for a workbench note, the read-time companion to
 * RCR's reversal-time check. It resolves each digest-bound `rcr` anchor against the
 * current tape (an anchor is broken when its event is gone or its content digest
 * drifted) and aggregates. `findEventPayload` performs the synchronous in-memory
 * tape lookup; resolution itself is the pure `resolveRcrReferenceAgainst`. Notes
 * without `rcr` anchors are `unverifiable` here: free-form `sourceRefs` and `file:`
 * workspace verification are intentionally out of scope for this pass.
 */
export function resolveWorkbenchEntryStaleness(input: {
  readonly rcr?: readonly RcrReference[];
  readonly findEventPayload: (eventRef: RcrEventRef) => unknown;
}): WorkbenchEntryStaleness {
  const outcomes = (input.rcr ?? []).map<WorkbenchRefOutcome>((ref) => {
    const payload = input.findEventPayload(ref.eventRef);
    if (payload === undefined) return "broken";
    const located = extractRcrContentPath(payload, ref.contentPath);
    return resolveRcrReferenceAgainst(ref, located).status === "unresolvable_reference"
      ? "broken"
      : "resolved";
  });
  return aggregateWorkbenchEntryStaleness(outcomes);
}

export interface StaleAwareWorkbenchEntry<TEntry> {
  readonly entry: TEntry;
  readonly stale: boolean;
}

/**
 * Annotate workbench entries with their staleness verdict and, when the rendered
 * set exceeds `max`, keep the most recent live notes and only backfill with the
 * most recent stale ones — stale notes are downgraded (dropped first), never
 * deleted, and the surviving set keeps its original chronological order.
 */
export function selectStaleAwareWorkbenchEntries<
  TEntry extends { readonly rcr?: readonly RcrReference[] },
>(
  entries: readonly TEntry[],
  findEventPayload: (eventRef: RcrEventRef) => unknown,
  max: number,
): readonly StaleAwareWorkbenchEntry<TEntry>[] {
  const annotated = entries.map<StaleAwareWorkbenchEntry<TEntry>>((entry) => ({
    entry,
    stale: resolveWorkbenchEntryStaleness({ rcr: entry.rcr, findEventPayload }) === "stale",
  }));
  if (annotated.length <= max) {
    return annotated;
  }
  const live = annotated.filter((item) => !item.stale).slice(-max);
  const remaining = Math.max(0, max - live.length);
  const fill = remaining > 0 ? annotated.filter((item) => item.stale).slice(-remaining) : [];
  const keep = new Set([...live, ...fill]);
  return annotated.filter((item) => keep.has(item));
}

type RuntimeWorkbenchEntry = ReturnType<
  HostedRuntimeAdapterPort["ops"]["workbench"]["list"]
>[number];

/**
 * Gateway-layer stale-aware workbench selection: lists the session's workbench
 * entries, builds the in-memory RCR event lookup (only when an entry carries an
 * anchor), and applies {@link selectStaleAwareWorkbenchEntries}. The single source
 * of stale-aware selection for both the live `[Workbench]` render and the
 * workbench-primary compaction fallback, so neither path promotes an unmarked
 * stale note.
 */
export function selectStaleAwareWorkbenchEntriesForSession(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  max: number,
): readonly StaleAwareWorkbenchEntry<RuntimeWorkbenchEntry>[] {
  const entries = listRuntimeWorkbenchEntries(runtime, sessionId);
  const hasRcrAnchors = entries.some((entry) => (entry.rcr?.length ?? 0) > 0);
  const eventPayloadById = new Map<string, unknown>();
  if (hasRcrAnchors) {
    for (const event of queryRuntimeEvents(runtime, sessionId)) {
      eventPayloadById.set(event.id, event.payload);
    }
  }
  return selectStaleAwareWorkbenchEntries(
    entries,
    (eventRef) => eventPayloadById.get(eventRef.eventId),
    max,
  );
}
