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

function sameDigests(
  left: readonly RecallSessionDigest[],
  right: readonly RecallSessionDigest[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index];
    return (
      candidate?.sessionId === entry.sessionId &&
      candidate?.eventCount === entry.eventCount &&
      candidate?.lastEventAt === entry.lastEventAt &&
      candidate?.repositoryRoot === entry.repositoryRoot &&
      candidate?.primaryRoot === entry.primaryRoot &&
      JSON.stringify(candidate?.targetRoots ?? []) === JSON.stringify(entry.targetRoots) &&
      candidate?.digestText === entry.digestText
    );
  });
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

  constructor(private readonly runtime: RecallBrokerRuntime) {
    this.indexPromise = createSessionIndex({
      workspaceRoot: runtime.identity.workspaceRoot,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    runtime.inspect.events.records.subscribe((event) => {
      if (
        isSessionIndexTextIndexedEvent(event) ||
        RECALL_STATE_INVALIDATING_EVENT_TYPES.has(event.type)
      ) {
        this.dirty = true;
      }
    });
  }

  async sync(): Promise<RecallBrokerState> {
    if (!this.dirty && this.state) {
      return this.state;
    }
    const current = this.state ?? buildEmptyState();
    const sessionIndex = await this.indexPromise;
    const sessionDigests = (await sessionIndex.listSessionDigests())
      .filter((entry) => entry.digestText.trim().length > 0)
      .map(mapSessionIndexDigest);
    if (!this.dirty && sameDigests(current.sessionDigests, sessionDigests)) {
      this.state = current;
      return current;
    }
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
    this.dirty = false;
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
    const rankingContext = createRankingContext(input.sessionId, intent);
    const state = await this.sync();
    const queryTokens = tokenizeSearchQuery(query);
    const curationById = new Map(state.curation.map((entry) => [entry.stableId, entry]));
    const currentTarget = this.runtime.inspect.task.target.getDescriptor(input.sessionId);
    const targetRoots =
      currentTarget.roots.length > 0 ? currentTarget.roots : [currentTarget.primaryRoot];
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
    const rankingContext = createRankingContext(input.sessionId, undefined);
    const state = await this.sync();
    const curationById = new Map(state.curation.map((entry) => [entry.stableId, entry]));
    const currentTarget = this.runtime.inspect.task.target.getDescriptor(input.sessionId);
    const targetRoots =
      currentTarget.roots.length > 0 ? currentTarget.roots : [currentTarget.primaryRoot];
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
  const key = resolveRuntimeSourceIdentity(runtime as unknown as object);
  const existing = brokerByRuntime.get(key);
  if (existing) {
    return existing;
  }
  const created = new RecallBroker(runtime);
  brokerByRuntime.set(key, created);
  return created;
}
