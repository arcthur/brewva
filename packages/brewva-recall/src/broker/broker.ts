import { tokenizeSearchQuery } from "@brewva/brewva-search";
import { createSessionIndex, type SessionIndex } from "@brewva/brewva-session-index";
import { isSessionIndexTextIndexedEvent } from "@brewva/brewva-session-index/evidence";
import { uniqueNonEmptyStrings as uniqueStrings } from "@brewva/brewva-std/collections";
import { resolveRuntimeSourceIdentity } from "@brewva/brewva-std/runtime-identity";
import { classifyRecallTapeEvent } from "../evidence/index.js";
import { executeKnowledgeSearch, findKnowledgeDocByRelativePath } from "../knowledge/index.js";
import {
  RECALL_BROKER_STATE_SCHEMA,
  type RecallBrokerState,
  type RecallCurationAggregate,
  type RecallInspectResult,
  type RecallScope,
  type RecallSearchEntry,
  type RecallSearchIntent,
  type RecallSearchResult,
  type RecallSessionDigest,
} from "../types.js";
import {
  RECALL_STATE_INVALIDATING_EVENT_TYPES,
  buildCurationAggregates,
  buildCurationSnapshot,
  curationAdjustment,
} from "./curation.js";
import {
  compareRecallSearchEntries,
  computeRankingScore,
  createRankingContext,
  finalizeRecallEntry,
  type RecallRankingContext,
} from "./ranking.js";
import { type RecallBrokerRuntime } from "./runtime-port.js";
import { mapKnowledgeDoc } from "./source-mappers.js";
import { parseTapeStableId } from "./stable-id.js";
import {
  mapSessionIndexDigest,
  mapSessionIndexEvidenceToEvent,
  renderEventTitle,
} from "./tape-evidence.js";
import { compactText, computeTokenOverlap, freshnessFromTimestamp } from "./text.js";

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MAX_TAPE_SESSIONS = 6;
const DEFAULT_SCOPE: RecallScope = "user_repository_root";

// The hosted gateway writes this advisory ops event at each turn boundary (its
// turn-end lifecycle hook, fired from the turn_end extension in brewva-gateway).
// It arrives on the same publishEvent fan-out that already delivers
// recall.curation.recorded to this broker, so it is matched by string — it is an
// advisory ops kind, not a kernel canonical event and not a vocabulary constant.
// It is the off-critical-path signal to warm the broker.
const TURN_ENDED_OPS_EVENT_TYPE = "turn.ended";

const brokerByRuntime = new WeakMap<object, RecallBroker>();

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildEmptyState(): RecallBrokerState {
  return {
    schema: RECALL_BROKER_STATE_SCHEMA,
    updatedAt: Date.now(),
    sessionDigests: [],
    evidenceIndex: [],
    curation: [],
  };
}

function resolveTargetRoots(input: {
  readonly workspaceRoot: string;
  readonly target: {
    readonly primaryRoot?: string;
    readonly roots?: readonly string[];
  };
}): readonly string[] {
  const roots = input.target.roots?.filter((root) => root.trim().length > 0) ?? [];
  if (roots.length > 0) {
    return roots;
  }
  const primaryRoot = input.target.primaryRoot?.trim();
  return [primaryRoot && primaryRoot.length > 0 ? primaryRoot : input.workspaceRoot];
}

export interface RecallBrokerSearchInput {
  sessionId: string;
  query: string;
  scope?: RecallScope;
  intent?: RecallSearchIntent;
  limit?: number;
}

export interface RecallBrokerInspectInput {
  sessionId: string;
  stableIds: readonly string[];
  scope?: RecallScope;
}

export class RecallBroker {
  private readonly indexPromise: Promise<SessionIndex>;
  private state: RecallBrokerState | undefined;
  private dirty = true;
  // Bumped on every invalidating event. A build that starts at revision R clears
  // `dirty` only if the revision is unchanged when it finishes; if an event
  // landed mid-build the broker stays dirty and the next sync rebuilds, so a warm
  // in flight when an invalidation arrives can never publish soon-stale state.
  private revision = 0;
  // Single-flight: a background warm() and a concurrent live search() join one
  // in-flight sync() instead of racing two builds (two listSessionDigests round
  // trips plus two curation folds). Latency-only — it never changes what a search
  // returns. The underlying SqliteSessionIndex.catchUp() has its own writer gate;
  // this guard coalesces the broker-state layer above it.
  private syncInFlight: Promise<RecallBrokerState> | undefined;

  constructor(
    private readonly runtime: RecallBrokerRuntime,
    // Optional injected read model — a testability seam. Production callers
    // (getOrCreateRecallBroker) omit it and get the real SQLite-backed index.
    index?: SessionIndex | Promise<SessionIndex>,
  ) {
    this.indexPromise =
      index !== undefined
        ? Promise.resolve(index)
        : createSessionIndex({
            workspaceRoot: runtime.identity.workspaceRoot,
            events: runtime.events,
            task: runtime.task,
          });
    runtime.events.records.subscribe((event) => {
      if (
        isSessionIndexTextIndexedEvent(event) ||
        RECALL_STATE_INVALIDATING_EVENT_TYPES.has(event.type)
      ) {
        this.dirty = true;
        this.revision += 1;
      }
      if (event.type === TURN_ENDED_OPS_EVENT_TYPE) {
        // Warm off the turn's critical path so the next turn's first
        // recall_search resolves against a warm broker and read model. Warming is
        // dirty-gated inside warm(): a turn that changed nothing folds to a
        // fast-path no-op, so a quiet session never over-builds. Fire-and-forget —
        // a failed warm is a benign no-op (the next search just rebuilds cold).
        void this.warm().catch(() => {});
      }
    });
  }

  /**
   * Warm the broker off the turn's critical path: run the same dirty-gated
   * sync() a live search() would run, so the next explicit recall_search finds a
   * warm broker and read model. Performance-only — it never changes what a search
   * returns, only how fast it resolves. Returns void; broker/index warmth is its
   * only effect. Safe to fire-and-forget: it joins the single-flight sync shared
   * with any concurrent search(), and reads the index only (no provider call, no
   * embedding request, no network). A failed warm is a benign no-op — the next
   * explicit search just rebuilds cold — so the post-settlement trigger must
   * ignore its rejection rather than surface it to the turn.
   */
  async warm(): Promise<void> {
    await this.sync();
  }

  async sync(): Promise<RecallBrokerState> {
    if (!this.dirty && this.state) {
      return this.state;
    }
    const inFlight = this.syncInFlight;
    if (inFlight) {
      const joined = await inFlight;
      // If an invalidating event landed while that build ran, the joined state is
      // superseded; rebuild so a live search never observes stale state.
      return this.dirty ? this.sync() : joined;
    }
    const run = this.performSync();
    this.syncInFlight = run;
    let built: RecallBrokerState;
    try {
      built = await run;
    } finally {
      if (this.syncInFlight === run) {
        this.syncInFlight = undefined;
      }
    }
    // Owner symmetry with the joiner branch: if an invalidating event landed while
    // this build ran (revision moved, so performSync left the broker dirty), the
    // build is superseded — rebuild so the build's own caller never observes stale
    // state either, not just joiners. The owner's await settles before any joiner's
    // (it registered first), so the in-flight slot is already cleared here and the
    // rebuild coalesces joiners rather than spinning.
    return this.dirty ? this.sync() : built;
  }

  private async performSync(): Promise<RecallBrokerState> {
    const startRevision = this.revision;
    const sessionIndex = await this.indexPromise;
    const sessionDigests = (await sessionIndex.listSessionDigests())
      .filter((entry) => entry.digestText.trim().length > 0)
      .map(mapSessionIndexDigest);
    const next: RecallBrokerState = {
      schema: RECALL_BROKER_STATE_SCHEMA,
      updatedAt: Date.now(),
      sessionDigests,
      evidenceIndex: sessionDigests.map((entry) => ({
        sessionId: entry.sessionId,
        eventCount: entry.eventCount,
        lastEventAt: entry.lastEventAt,
        repositoryRoot: entry.repositoryRoot,
        primaryRoot: entry.primaryRoot,
        targetRoots: entry.targetRoots,
        digestText: entry.digestText,
      })),
      curation: buildCurationAggregates(this.runtime),
    };
    this.state = next;
    // Clear dirty only if no invalidating event arrived while we built; if one
    // did, the revision moved and the broker stays dirty so the next sync rebuilds.
    if (this.revision === startRevision) {
      this.dirty = false;
    }
    return next;
  }

  listCached(): RecallBrokerState {
    return this.state ?? buildEmptyState();
  }

  async search(input: RecallBrokerSearchInput): Promise<RecallSearchResult> {
    const query = normalizeQuery(input.query);
    const limit = Math.max(1, input.limit ?? DEFAULT_MAX_RESULTS);
    const scope = input.scope ?? DEFAULT_SCOPE;
    const intent = input.intent;
    const rankingContext = createRankingContext(
      input.sessionId,
      intent,
      this.runtime.identity.workspaceRoot,
    );
    const state = await this.sync();
    const queryTokens = tokenizeSearchQuery(query);
    const curationById = new Map(state.curation.map((entry) => [entry.stableId, entry]));
    const currentTarget = this.runtime.task.target.getDescriptor(input.sessionId);
    const targetRoots = resolveTargetRoots({
      workspaceRoot: this.runtime.identity.workspaceRoot,
      target: currentTarget,
    });
    const sessionIndex = await this.indexPromise;
    const tapeCandidateDigests = (
      await sessionIndex.querySessionDigests({
        currentSessionId: input.sessionId,
        scope,
        targetRoots,
        query,
        limit: Math.max(DEFAULT_MAX_TAPE_SESSIONS, limit * 2),
      })
    ).map(mapSessionIndexDigest);

    const results: RecallSearchEntry[] = [];
    results.push(
      ...(await this.searchTapeEvidence(
        tapeCandidateDigests,
        rankingContext,
        query,
        queryTokens,
        scope,
        limit,
      )),
    );
    results.push(
      ...executeKnowledgeSearch([this.runtime.identity.workspaceRoot], {
        query,
        limit,
      }).results.map((entry) =>
        mapKnowledgeDoc(
          entry.doc,
          entry.relevanceScore / 100,
          entry.matchReasons,
          scope,
          rankingContext,
        ),
      ),
    );

    return {
      query,
      scope,
      ...(intent ? { intent } : {}),
      results: this.applyCuration(results, curationById, rankingContext)
        .toSorted(compareRecallSearchEntries)
        .slice(0, limit),
    };
  }

  async inspectStableIds(input: RecallBrokerInspectInput): Promise<RecallInspectResult> {
    const scope = input.scope ?? DEFAULT_SCOPE;
    const rankingContext = createRankingContext(
      input.sessionId,
      undefined,
      this.runtime.identity.workspaceRoot,
    );
    const state = await this.sync();
    const curationById = new Map(state.curation.map((entry) => [entry.stableId, entry]));
    const currentTarget = this.runtime.task.target.getDescriptor(input.sessionId);
    const targetRoots = resolveTargetRoots({
      workspaceRoot: this.runtime.identity.workspaceRoot,
      target: currentTarget,
    });
    const sessionIndex = await this.indexPromise;
    const requestedStableIds = uniqueStrings(
      input.stableIds.map((stableId) => stableId.trim()).filter((stableId) => stableId.length > 0),
    );
    const resolvedResults: RecallSearchEntry[] = [];
    const unresolvedStableIds: string[] = [];

    for (const stableId of requestedStableIds) {
      const resolved = await this.resolveStableId(
        stableId,
        sessionIndex,
        targetRoots,
        scope,
        rankingContext,
      );
      if (!resolved) {
        unresolvedStableIds.push(stableId);
        continue;
      }
      resolvedResults.push(resolved);
    }

    return {
      scope,
      requestedStableIds,
      unresolvedStableIds,
      results: this.applyCuration(resolvedResults, curationById, rankingContext).toSorted(
        compareRecallSearchEntries,
      ),
    };
  }

  private async searchTapeEvidence(
    candidateDigests: readonly RecallSessionDigest[],
    rankingContext: RecallRankingContext,
    query: string,
    queryTokens: readonly string[],
    scope: RecallScope,
    limit: number,
  ): Promise<RecallSearchEntry[]> {
    const { currentSessionId } = rankingContext;
    const rankedDigests = candidateDigests.slice(0, Math.max(DEFAULT_MAX_TAPE_SESSIONS, limit * 2));

    const sessionIndex = await this.indexPromise;
    const evidenceRows = await sessionIndex.queryTapeEvidence({
      sessionIds: rankedDigests.map((entry) => entry.sessionId),
      query,
      limit: Math.max(DEFAULT_MAX_TAPE_SESSIONS, limit * 4),
    });
    const digestBySessionId = new Map(rankedDigests.map((entry) => [entry.sessionId, entry]));
    const results: RecallSearchEntry[] = [];
    for (const evidence of evidenceRows) {
      const digest = digestBySessionId.get(evidence.sessionId);
      if (!digest) continue;
      const event = mapSessionIndexEvidenceToEvent(evidence);
      const text = evidence.searchText;
      if (!text) continue;
      const overlap = evidence.tokenScore;
      if (overlap <= 0) continue;
      const classification = classifyRecallTapeEvent(event, currentSessionId);
      results.push(
        finalizeRecallEntry(
          {
            stableId: `tape:${digest.sessionId}:${event.id}`,
            sourceFamily: "tape_evidence",
            sessionScope:
              digest.sessionId === currentSessionId ? "current_session" : "prior_session",
            rootRef:
              digest.primaryRoot || digest.targetRoots[0] || this.runtime.identity.workspaceRoot,
            trustLabel: classification.trustLabel,
            evidenceStrength: classification.evidenceStrength,
            scope,
            semanticScore:
              overlap +
              Math.min(0.12, computeTokenOverlap(queryTokens, digest.digestText) * 0.25) +
              (digest.sessionId === currentSessionId ? 0.03 : 0),
            title: renderEventTitle(event),
            summary: compactText(text, 160),
            excerpt: compactText(text, 220),
            freshness: freshnessFromTimestamp(event.timestamp),
            matchReasons: ["event_text"],
            sessionId: digest.sessionId,
            targetRoots: digest.targetRoots,
          },
          rankingContext,
        ),
      );
    }
    return results;
  }

  private async filterSessionIdsByScope(
    sessionIndex: SessionIndex,
    currentSessionId: string,
    scope: RecallScope,
    targetRoots: readonly string[],
    sessionIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const uniqueSessionIds = uniqueStrings(sessionIds);
    if (uniqueSessionIds.length === 0) return new Set();
    if (scope === "workspace_wide") return new Set(uniqueSessionIds);
    return new Set(
      await sessionIndex.filterSessionIdsByScope({
        currentSessionId,
        scope,
        targetRoots,
        sessionIds: uniqueSessionIds,
      }),
    );
  }

  private async isSessionInScope(
    sessionIndex: SessionIndex,
    sessionId: string,
    targetRoots: readonly string[],
    scope: RecallScope,
    rankingContext: RecallRankingContext,
  ): Promise<boolean> {
    if (scope === "workspace_wide") return true;
    const scopedSessionIds = await this.filterSessionIdsByScope(
      sessionIndex,
      rankingContext.currentSessionId,
      scope,
      targetRoots,
      [sessionId],
    );
    return scopedSessionIds.has(sessionId);
  }

  private applyCuration(
    entries: readonly RecallSearchEntry[],
    curationById: ReadonlyMap<string, RecallCurationAggregate>,
    rankingContext: RecallRankingContext,
  ): RecallSearchEntry[] {
    return [
      ...new Map(
        entries.map((entry) => {
          const curation = curationById.get(entry.stableId);
          const scoreAdjustment = curationAdjustment(curation);
          const ranked = computeRankingScore(entry, rankingContext, scoreAdjustment);
          return [
            entry.stableId,
            {
              ...entry,
              rankingScore: ranked.rankingScore,
              rankReasons: ranked.rankReasons,
              curation: buildCurationSnapshot(curation),
            },
          ] as const;
        }),
      ).values(),
    ];
  }

  private async resolveStableId(
    stableId: string,
    sessionIndex: SessionIndex,
    targetRoots: readonly string[],
    scope: RecallScope,
    rankingContext: RecallRankingContext,
  ): Promise<RecallSearchEntry | undefined> {
    if (stableId.startsWith("tape:")) {
      return await this.resolveTapeStableId(
        stableId,
        sessionIndex,
        targetRoots,
        scope,
        rankingContext,
      );
    }
    if (stableId.startsWith("precedent:")) {
      const doc = findKnowledgeDocByRelativePath(
        [this.runtime.identity.workspaceRoot],
        stableId.slice("precedent:".length),
      );
      return doc ? mapKnowledgeDoc(doc, 0.4, ["stable_id"], scope, rankingContext) : undefined;
    }
    return undefined;
  }

  private async resolveTapeStableId(
    stableId: string,
    sessionIndex: SessionIndex,
    targetRoots: readonly string[],
    scope: RecallScope,
    rankingContext: RecallRankingContext,
  ): Promise<RecallSearchEntry | undefined> {
    const parsed = parseTapeStableId(stableId);
    if (!parsed) {
      return undefined;
    }
    const { sessionId, eventId } = parsed;
    if (
      !(await this.isSessionInScope(sessionIndex, sessionId, targetRoots, scope, rankingContext))
    ) {
      return undefined;
    }
    const digest = await sessionIndex.getSessionDigest({ sessionId });
    if (!digest) {
      return undefined;
    }
    const evidence = await sessionIndex.getTapeEvent({ sessionId, eventId });
    if (!evidence) {
      return undefined;
    }
    const event = mapSessionIndexEvidenceToEvent(evidence);
    if (!isSessionIndexTextIndexedEvent(event) || !evidence.searchText) {
      return undefined;
    }
    const text = evidence.searchText;
    const classification = classifyRecallTapeEvent(event, rankingContext.currentSessionId);
    return finalizeRecallEntry(
      {
        stableId,
        sourceFamily: "tape_evidence",
        sessionScope:
          digest.sessionId === rankingContext.currentSessionId
            ? "current_session"
            : "prior_session",
        rootRef: digest.primaryRoot || digest.targetRoots[0] || this.runtime.identity.workspaceRoot,
        trustLabel: classification.trustLabel,
        evidenceStrength: classification.evidenceStrength,
        scope,
        semanticScore: 0.4,
        title: renderEventTitle(event),
        summary: compactText(text, 160),
        excerpt: compactText(text, 220),
        freshness: freshnessFromTimestamp(event.timestamp),
        matchReasons: ["stable_id"],
        sessionId: digest.sessionId,
        targetRoots: digest.targetRoots,
      },
      rankingContext,
    );
  }
}

export function getOrCreateRecallBroker(runtime: RecallBrokerRuntime): RecallBroker {
  const key = resolveRuntimeSourceIdentity(runtime.cacheKey ?? (runtime as unknown as object));
  const existing = brokerByRuntime.get(key);
  if (existing) {
    return existing;
  }
  const created = new RecallBroker(runtime);
  brokerByRuntime.set(key, created);
  return created;
}
