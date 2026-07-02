import {
  extractRcrContentPath,
  resolveRcrReferenceAgainst,
  type RcrEventRef,
  type RcrReference,
} from "@brewva/brewva-vocabulary/rcr";
import {
  isAttentionPinnedWorkbenchEntry,
  parseWorkbenchEvictionSpanRef,
  WORKBENCH_EVICTION_UNDONE_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
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
 *
 * `attention_pin` entries sit outside the candidate set entirely: they are kept
 * unconditionally (even stale — the marker stays honest), consume the render
 * budget first, and only an explicit `workbench_evict` targeting `entry:<id>`
 * removes them. That is the retention contract: what the model pinned, physics
 * keeps.
 */
export function selectStaleAwareWorkbenchEntries<
  TEntry extends { readonly rcr?: readonly RcrReference[]; readonly retentionHint?: string },
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
  const pinned = annotated.filter((item) => isAttentionPinnedWorkbenchEntry(item.entry));
  const candidates = annotated.filter((item) => !isAttentionPinnedWorkbenchEntry(item.entry));
  // `slice(-0)` would return the whole array, so a zero budget must short-circuit.
  const budget = Math.max(0, max - pinned.length);
  const live = budget > 0 ? candidates.filter((item) => !item.stale).slice(-budget) : [];
  const remaining = Math.max(0, budget - live.length);
  const fill = remaining > 0 ? candidates.filter((item) => item.stale).slice(-remaining) : [];
  const keep = new Set([...pinned, ...live, ...fill]);
  return annotated.filter((item) => keep.has(item));
}

type RuntimeWorkbenchEntry = ReturnType<
  HostedRuntimeAdapterPort["ops"]["workbench"]["list"]
>[number];

function readUndoneEvictionIds(
  events: readonly { type: string; payload?: unknown }[],
): Set<string> {
  const undone = new Set<string>();
  for (const event of events) {
    if (event.type !== WORKBENCH_EVICTION_UNDONE_EVENT_TYPE) continue;
    const payload = event.payload as { entryId?: unknown; undone?: unknown } | undefined;
    if (payload?.undone === true && typeof payload.entryId === "string") {
      undone.add(payload.entryId);
    }
  }
  return undone;
}

/**
 * Note-level eviction physics: an active (not undone) eviction entry whose
 * span refs target `entry:<noteId>` removes that NOTE from the selectable set.
 * This is the retention contract's explicit release path — the ONLY way an
 * `attention_pin` note leaves the render — and it applies to unpinned notes
 * uniformly (an explicitly evicted note must not linger in the render either).
 * Strictly note-scoped: eviction entries themselves are never dropped here, so
 * their message-hiding span refs stay in force for `transformContext` and the
 * session-store visibility path (dropping them would silently resurrect
 * evicted history). Undoing an eviction restores the note; the pre-existing
 * asymmetry that undone evictions never restore hidden MESSAGES lives in
 * `createEvictionIndex`, not here.
 */
function dropExplicitlyEvictedNotes(
  entries: readonly RuntimeWorkbenchEntry[],
  undoneEvictionIds: ReadonlySet<string>,
): readonly RuntimeWorkbenchEntry[] {
  const evictedNoteIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "eviction") continue;
    if (entry.id && undoneEvictionIds.has(entry.id)) continue;
    for (const sourceRef of entry.sourceRefs) {
      const parsed = parseWorkbenchEvictionSpanRef(sourceRef);
      if (parsed?.prefix === "entry") {
        evictedNoteIds.add(parsed.id);
      }
    }
  }
  if (evictedNoteIds.size === 0) return entries;
  return entries.filter(
    (entry) => !(entry.kind === "note" && entry.id && evictedNoteIds.has(entry.id)),
  );
}

/**
 * Workbench entries still in force: the raw projection minus notes the model
 * explicitly evicted via `entry:<id>` span refs (honoring undo). The one list
 * every model-facing surface (render, compaction fallback, pinned-mass
 * accounting) must read, so an evicted pin cannot linger anywhere. The undo
 * lookup is a type-filtered event query and runs only when an eviction exists.
 */
export function listActiveWorkbenchEntriesForSession(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): readonly RuntimeWorkbenchEntry[] {
  const listed = listRuntimeWorkbenchEntries(runtime, sessionId);
  if (!listed.some((entry) => entry.kind === "eviction")) {
    return listed;
  }
  const undone = readUndoneEvictionIds(
    queryRuntimeEvents(runtime, sessionId, { type: WORKBENCH_EVICTION_UNDONE_EVENT_TYPE }),
  );
  return dropExplicitlyEvictedNotes(listed, undone);
}

/**
 * Gateway-layer stale-aware workbench selection: takes the active entry list
 * ({@link listActiveWorkbenchEntriesForSession}), builds the in-memory RCR event
 * lookup (only when an entry carries an anchor), and applies
 * {@link selectStaleAwareWorkbenchEntries}. The single source of stale-aware
 * selection for both the live `[Workbench]` render and the workbench-primary
 * compaction fallback, so neither path promotes an unmarked stale note or
 * resurrects an evicted pin.
 */
export function selectStaleAwareWorkbenchEntriesForSession(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  max: number,
): readonly StaleAwareWorkbenchEntry<RuntimeWorkbenchEntry>[] {
  const entries = listActiveWorkbenchEntriesForSession(runtime, sessionId);
  const eventPayloadById = new Map<string, unknown>();
  if (entries.some((entry) => (entry.rcr?.length ?? 0) > 0)) {
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
