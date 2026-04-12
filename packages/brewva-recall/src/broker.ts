import { resolve, sep } from "node:path";
import {
  getOrCreateDeliberationMemoryPlane,
  getOrCreateNarrativeMemoryPlane,
  getOrCreateOptimizationContinuityPlane,
  tokenize,
  uniqueStrings,
  type DeliberationMemoryArtifact,
  type NarrativeMemoryRecord,
  type OptimizationLineageArtifact,
} from "@brewva/brewva-deliberation";
import type { BrewvaEventRecord, BrewvaInspectionPort } from "@brewva/brewva-runtime";
import {
  getOrCreateSkillPromotionBroker,
  type SkillPromotionDraft,
} from "@brewva/brewva-skill-broker";
import {
  executeKnowledgeSearch,
  findKnowledgeDocByRelativePath,
  type KnowledgeDocRecord,
} from "./knowledge-search-core.js";
import { collectRecallSessionDigests } from "./session-digests.js";
import { FileRecallBrokerStore } from "./store.js";
import {
  RECALL_CURATION_HALFLIFE_DAYS,
  RECALL_BROKER_STATE_SCHEMA,
  type RecallBrokerState,
  type RecallCurationAggregate,
  type RecallInspectResult,
  type RecallFreshness,
  type RecallScope,
  type RecallCurationSnapshot,
  type RecallSearchEntry,
  type RecallSearchResult,
  type RecallSessionDigest,
} from "./types.js";

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MAX_TAPE_SESSIONS = 6;
const DEFAULT_SCOPE: RecallScope = "user_repository_root";
const RECALL_CURATION_HALFLIFE_MS = RECALL_CURATION_HALFLIFE_DAYS * 24 * 60 * 60 * 1000;

interface RecallBrokerEventsPort extends Pick<
  BrewvaInspectionPort["events"],
  "listSessionIds" | "list" | "subscribe"
> {}

export interface RecallBrokerRuntime {
  readonly workspaceRoot: string;
  readonly agentId: string;
  readonly inspect: {
    readonly events: RecallBrokerEventsPort;
    readonly task: Pick<BrewvaInspectionPort["task"], "getTargetDescriptor">;
    readonly skills: Pick<BrewvaInspectionPort["skills"], "list">;
  };
  readonly internal?: {
    recordEvent?: (input: {
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
      timestamp?: number;
      skipTapeCheckpoint?: boolean;
    }) => unknown;
  };
}

const brokerByRuntime = new WeakMap<object, RecallBroker>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry) ?? "").filter((entry) => entry.length > 0);
}

function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function freshnessFromTimestamp(timestamp: number | undefined): RecallFreshness {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "unknown";
  }
  const ageDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  if (ageDays <= 30) return "fresh";
  if (ageDays <= 180) return "aging";
  return "stale";
}

function computeTokenOverlap(queryTokens: readonly string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const textTokens = new Set(tokenize(text));
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.length;
}

function collectStringLeaves(value: unknown, sink: string[]): void {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      sink.push(normalized);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, sink);
    }
    return;
  }
  for (const entry of Object.values(value)) {
    collectStringLeaves(entry, sink);
  }
}

function extractEventSearchText(event: BrewvaEventRecord): string {
  const parts = [event.type];
  if (isRecord(event.payload)) {
    const leaves: string[] = [];
    collectStringLeaves(event.payload, leaves);
    parts.push(...leaves.slice(0, 8));
  }
  return compactText(parts.join(" "), 600);
}

function renderEventTitle(event: BrewvaEventRecord): string {
  return compactText(`${event.type} (${event.sessionId})`, 120);
}

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

function buildCurationAggregates(runtime: RecallBrokerRuntime): RecallCurationAggregate[] {
  const byStableId = new Map<string, RecallCurationAggregate>();
  for (const sessionId of runtime.inspect.events.listSessionIds()) {
    for (const event of runtime.inspect.events.list(sessionId)) {
      if (event.type !== "recall_curation_recorded" && event.type !== "recall_utility_observed") {
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

function curationAdjustment(curation: RecallCurationAggregate | undefined): number {
  if (!curation) return 0;
  return (
    Math.min(0.18, curation.helpfulWeight * 0.04) -
    Math.min(0.12, curation.staleWeight * 0.03) -
    Math.min(0.2, curation.supersededWeight * 0.05) -
    Math.min(0.16, curation.wrongScopeWeight * 0.04) -
    Math.min(0.24, curation.misleadingWeight * 0.06)
  );
}

function buildCurationSnapshot(
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

function mapNarrativeRecord(
  record: NarrativeMemoryRecord,
  score: number,
  matchReasons: string[],
  scope: RecallScope = DEFAULT_SCOPE,
): RecallSearchEntry {
  return {
    stableId: `narrative:${record.id}`,
    sourceFamily: "narrative_memory",
    scope,
    score,
    title: record.title,
    summary: record.summary,
    excerpt: compactText(record.content, 220),
    freshness: freshnessFromTimestamp(record.updatedAt),
    matchReasons: matchReasons.length > 0 ? matchReasons : ["retrieval_match"],
    targetRoots: record.provenance.targetRoots,
  };
}

function mapDeliberationArtifact(
  artifact: DeliberationMemoryArtifact,
  score: number,
  matchReasons: string[],
  scope: RecallScope = DEFAULT_SCOPE,
): RecallSearchEntry {
  return {
    stableId: `deliberation:${artifact.id}`,
    sourceFamily: "deliberation_memory",
    scope,
    score,
    title: artifact.title,
    summary: artifact.summary,
    excerpt: compactText(artifact.content, 220),
    freshness: freshnessFromTimestamp(artifact.lastValidatedAt),
    matchReasons: matchReasons.length > 0 ? matchReasons : ["retrieval_match"],
    sessionId: artifact.sessionIds.at(-1),
  };
}

function mapOptimizationLineage(
  artifact: OptimizationLineageArtifact,
  score: number,
  matchReasons: string[],
  scope: RecallScope = DEFAULT_SCOPE,
): RecallSearchEntry {
  return {
    stableId: `optimization:${artifact.id}`,
    sourceFamily: "optimization_continuity",
    scope,
    score,
    title: artifact.goal ?? artifact.loopKey,
    summary: artifact.summary,
    excerpt: compactText(artifact.summary, 220),
    freshness: freshnessFromTimestamp(artifact.lastObservedAt),
    matchReasons,
    sessionId: artifact.rootSessionId,
  };
}

function mapPromotionDraft(
  draft: SkillPromotionDraft,
  queryTokens: readonly string[],
  scope: RecallScope = DEFAULT_SCOPE,
): RecallSearchEntry | null {
  const score = computeTokenOverlap(
    queryTokens,
    `${draft.title} ${draft.summary} ${draft.rationale} ${draft.proposalText} ${draft.tags.join(" ")}`,
  );
  if (score <= 0) return null;
  return {
    stableId: `promotion:${draft.id}`,
    sourceFamily: "promotion_draft",
    scope,
    score: score + draft.confidenceScore * 0.25 + Math.min(0.12, draft.repeatCount * 0.04),
    title: draft.title,
    summary: draft.summary,
    excerpt: compactText(draft.proposalText, 220),
    freshness: freshnessFromTimestamp(draft.lastValidatedAt),
    matchReasons: draft.tags.slice(0, 4),
    sessionId: draft.sessionIds.at(-1),
  };
}

function mapKnowledgeDoc(
  doc: KnowledgeDocRecord,
  score: number,
  matchReasons: string[],
  scope: RecallScope = DEFAULT_SCOPE,
): RecallSearchEntry {
  return {
    stableId: `precedent:${doc.relativePath}`,
    sourceFamily: "repository_precedent",
    scope,
    score,
    title: doc.title,
    summary: `${doc.sourceType} @ ${doc.relativePath}`,
    excerpt: doc.excerpt,
    freshness: doc.freshness,
    matchReasons,
    relativePath: doc.relativePath,
  };
}

export interface RecallBrokerSearchInput {
  sessionId: string;
  query: string;
  scope?: RecallScope;
  limit?: number;
}

export interface RecallBrokerInspectInput {
  sessionId: string;
  stableIds: readonly string[];
  scope?: RecallScope;
}

export class RecallBroker {
  private readonly store: FileRecallBrokerStore;
  private state: RecallBrokerState | undefined;
  private dirty = true;

  constructor(private readonly runtime: RecallBrokerRuntime) {
    this.store = new FileRecallBrokerStore(runtime.workspaceRoot);
    runtime.inspect.events.subscribe((event) => {
      if (
        event.type.startsWith("task_") ||
        event.type.startsWith("truth_") ||
        event.type.startsWith("skill_") ||
        event.type.startsWith("recall_") ||
        event.type === "tool_result_recorded"
      ) {
        this.dirty = true;
      }
    });
  }

  sync(): RecallBrokerState {
    const current = this.store.read() ?? this.state ?? buildEmptyState();
    const sessionDigests = collectRecallSessionDigests(this.runtime.inspect.events, {
      task: this.runtime.inspect.task,
      workspaceRoot: this.runtime.workspaceRoot,
    });
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
    this.store.write(next);
    this.state = next;
    this.dirty = false;
    return next;
  }

  listCached(): RecallBrokerState {
    return this.state ?? this.store.read() ?? buildEmptyState();
  }

  search(input: RecallBrokerSearchInput): RecallSearchResult {
    const query = normalizeQuery(input.query);
    const limit = Math.max(1, input.limit ?? DEFAULT_MAX_RESULTS);
    const scope = input.scope ?? DEFAULT_SCOPE;
    const state = this.sync();
    const queryTokens = uniqueStrings(tokenize(query));
    const curationById = new Map(state.curation.map((entry) => [entry.stableId, entry]));
    const currentTarget = this.runtime.inspect.task.getTargetDescriptor(input.sessionId);
    const targetRoots =
      currentTarget.roots.length > 0 ? currentTarget.roots : [currentTarget.primaryRoot];
    const candidateDigests = this.resolveScopedDigests(state, input.sessionId, scope, targetRoots);
    const scopedSessionIds = new Set(candidateDigests.map((entry) => entry.sessionId));

    const results: RecallSearchEntry[] = [];
    results.push(
      ...this.searchTapeEvidence(candidateDigests, input.sessionId, queryTokens, scope, limit),
    );
    results.push(
      ...getOrCreateNarrativeMemoryPlane(this.runtime)
        .retrieve(query, {
          limit,
          targetRoots,
        })
        .map((entry) =>
          mapNarrativeRecord(
            entry.record,
            entry.score,
            entry.matchedTerms.length > 0 ? entry.matchedTerms : ["retrieval_match"],
            scope,
          ),
        ),
    );
    results.push(
      ...getOrCreateDeliberationMemoryPlane(this.runtime)
        .retrieve(query, limit, targetRoots)
        .map((entry) =>
          mapDeliberationArtifact(
            entry.artifact,
            entry.score,
            entry.artifact.tags.length > 0 ? entry.artifact.tags.slice(0, 4) : ["retrieval_match"],
            scope,
          ),
        ),
    );
    results.push(
      ...getOrCreateOptimizationContinuityPlane(this.runtime)
        .retrieve(query, limit)
        .filter(
          (entry) =>
            scope === "workspace_wide" ||
            !entry.artifact.rootSessionId ||
            scopedSessionIds.has(entry.artifact.rootSessionId),
        )
        .map((entry) =>
          mapOptimizationLineage(
            entry.artifact,
            entry.score,
            uniqueStrings([
              entry.artifact.status,
              entry.artifact.loopKey,
              ...(entry.artifact.scope ?? []),
            ]).slice(0, 4),
            scope,
          ),
        ),
    );
    results.push(
      ...getOrCreateSkillPromotionBroker(this.runtime)
        .list({ limit })
        .filter(
          (draft) =>
            scope === "workspace_wide" ||
            draft.sessionIds.some((sessionId) => scopedSessionIds.has(sessionId)),
        )
        .map((draft) => mapPromotionDraft(draft, queryTokens, scope))
        .filter((entry): entry is RecallSearchEntry => Boolean(entry)),
    );
    results.push(
      ...executeKnowledgeSearch([this.runtime.workspaceRoot], { query, limit }).results.map(
        (entry) =>
          mapKnowledgeDoc(entry.doc, entry.relevanceScore / 100, entry.matchReasons, scope),
      ),
    );

    return {
      query,
      scope,
      results: this.applyCuration(results, curationById)
        .toSorted(
          (left, right) => right.score - left.score || left.stableId.localeCompare(right.stableId),
        )
        .slice(0, limit),
    };
  }

  inspectStableIds(input: RecallBrokerInspectInput): RecallInspectResult {
    const scope = input.scope ?? DEFAULT_SCOPE;
    const state = this.sync();
    const curationById = new Map(state.curation.map((entry) => [entry.stableId, entry]));
    const currentTarget = this.runtime.inspect.task.getTargetDescriptor(input.sessionId);
    const targetRoots =
      currentTarget.roots.length > 0 ? currentTarget.roots : [currentTarget.primaryRoot];
    const candidateDigests = this.resolveScopedDigests(state, input.sessionId, scope, targetRoots);
    const scopedSessionIds = new Set(candidateDigests.map((entry) => entry.sessionId));
    const requestedStableIds = uniqueStrings(
      input.stableIds.map((stableId) => stableId.trim()).filter((stableId) => stableId.length > 0),
    );
    const resolvedResults: RecallSearchEntry[] = [];
    const unresolvedStableIds: string[] = [];

    for (const stableId of requestedStableIds) {
      const resolved = this.resolveStableId(stableId, candidateDigests, scopedSessionIds, scope);
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
      results: this.applyCuration(resolvedResults, curationById).toSorted(
        (left, right) => right.score - left.score || left.stableId.localeCompare(right.stableId),
      ),
    };
  }

  private searchTapeEvidence(
    candidateDigests: readonly RecallSessionDigest[],
    currentSessionId: string,
    queryTokens: readonly string[],
    scope: RecallScope,
    limit: number,
  ): RecallSearchEntry[] {
    const rankedDigests = candidateDigests
      .map((entry) => ({
        digest: entry,
        score:
          computeTokenOverlap(queryTokens, `${entry.taskGoal ?? ""} ${entry.digestText}`) +
          (entry.sessionId === currentSessionId ? 0.02 : 0),
      }))
      .filter((entry) => entry.score > 0 || entry.digest.sessionId === currentSessionId)
      .toSorted(
        (left, right) =>
          right.score - left.score || right.digest.lastEventAt - left.digest.lastEventAt,
      )
      .slice(0, Math.max(DEFAULT_MAX_TAPE_SESSIONS, limit * 2))
      .map((entry) => entry.digest);

    const results: RecallSearchEntry[] = [];
    for (const digest of rankedDigests) {
      for (const event of this.runtime.inspect.events.list(digest.sessionId)) {
        const text = extractEventSearchText(event);
        const overlap = computeTokenOverlap(queryTokens, text);
        if (overlap <= 0) continue;
        results.push({
          stableId: `tape:${digest.sessionId}:${event.id}`,
          sourceFamily: "tape_evidence",
          scope,
          score:
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
        });
      }
    }
    return results;
  }

  private resolveScopedDigests(
    state: RecallBrokerState,
    currentSessionId: string,
    scope: RecallScope,
    currentTargetRoots: readonly string[],
  ): RecallSessionDigest[] {
    const normalizedCurrentRoots = this.normalizeTargetRoots(currentTargetRoots);
    return state.sessionDigests.filter((entry) => {
      if (scope === "session_local") {
        return entry.sessionId === currentSessionId;
      }
      if (scope === "workspace_wide") {
        return true;
      }
      return (
        entry.repositoryRoot === resolve(this.runtime.workspaceRoot) &&
        this.targetRootsOverlap(entry.targetRoots, normalizedCurrentRoots)
      );
    });
  }

  private normalizeTargetRoots(roots: readonly string[]): string[] {
    const normalized = uniqueStrings(
      roots
        .map((root) => root.trim())
        .filter((root) => root.length > 0)
        .map((root) => resolve(root)),
    );
    return normalized.length > 0 ? normalized : [resolve(this.runtime.workspaceRoot)];
  }

  private targetRootsOverlap(left: readonly string[], right: readonly string[]): boolean {
    const normalizedLeft = this.normalizeTargetRoots(left);
    const normalizedRight = this.normalizeTargetRoots(right);
    return normalizedLeft.some((leftRoot) =>
      normalizedRight.some((rightRoot) => this.pathsOverlap(leftRoot, rightRoot)),
    );
  }

  private pathsOverlap(left: string, right: string): boolean {
    const resolvedLeft = resolve(left);
    const resolvedRight = resolve(right);
    if (resolvedLeft === resolvedRight) {
      return true;
    }
    const leftPrefix = resolvedLeft.endsWith(sep) ? resolvedLeft : `${resolvedLeft}${sep}`;
    const rightPrefix = resolvedRight.endsWith(sep) ? resolvedRight : `${resolvedRight}${sep}`;
    return resolvedLeft.startsWith(rightPrefix) || resolvedRight.startsWith(leftPrefix);
  }

  private applyCuration(
    entries: readonly RecallSearchEntry[],
    curationById: ReadonlyMap<string, RecallCurationAggregate>,
  ): RecallSearchEntry[] {
    return [
      ...new Map(
        entries.map((entry) => {
          const curation = curationById.get(entry.stableId);
          const scoreAdjustment = curationAdjustment(curation);
          return [
            entry.stableId,
            {
              ...entry,
              score: entry.score + scoreAdjustment,
              curation: buildCurationSnapshot(curation),
            },
          ] as const;
        }),
      ).values(),
    ];
  }

  private resolveStableId(
    stableId: string,
    candidateDigests: readonly RecallSessionDigest[],
    scopedSessionIds: ReadonlySet<string>,
    scope: RecallScope,
  ): RecallSearchEntry | undefined {
    if (stableId.startsWith("tape:")) {
      return this.resolveTapeStableId(stableId, candidateDigests, scope);
    }
    if (stableId.startsWith("narrative:")) {
      const record = getOrCreateNarrativeMemoryPlane(this.runtime).getRecord(
        stableId.slice("narrative:".length),
      );
      return record ? mapNarrativeRecord(record, 0.4, ["stable_id"]) : undefined;
    }
    if (stableId.startsWith("deliberation:")) {
      const artifact = getOrCreateDeliberationMemoryPlane(this.runtime).getArtifact(
        stableId.slice("deliberation:".length),
      );
      return artifact ? mapDeliberationArtifact(artifact, 0.4, ["stable_id"]) : undefined;
    }
    if (stableId.startsWith("optimization:")) {
      const lineage = getOrCreateOptimizationContinuityPlane(this.runtime).getLineage(
        stableId.slice("optimization:".length),
      );
      if (!lineage) {
        return undefined;
      }
      if (
        scope !== "workspace_wide" &&
        lineage.rootSessionId &&
        !scopedSessionIds.has(lineage.rootSessionId)
      ) {
        return undefined;
      }
      return mapOptimizationLineage(
        lineage,
        0.4,
        uniqueStrings([lineage.status, lineage.loopKey, "stable_id"]).slice(0, 4),
      );
    }
    if (stableId.startsWith("promotion:")) {
      const draft = getOrCreateSkillPromotionBroker(this.runtime).getDraft(
        stableId.slice("promotion:".length),
      );
      if (!draft) {
        return undefined;
      }
      if (
        scope !== "workspace_wide" &&
        draft.sessionIds.length > 0 &&
        !draft.sessionIds.some((sessionId) => scopedSessionIds.has(sessionId))
      ) {
        return undefined;
      }
      return {
        stableId: `promotion:${draft.id}`,
        sourceFamily: "promotion_draft",
        scope,
        score: 0.4,
        title: draft.title,
        summary: draft.summary,
        excerpt: compactText(draft.proposalText, 220),
        freshness: freshnessFromTimestamp(draft.lastValidatedAt),
        matchReasons: ["stable_id", ...draft.tags.slice(0, 3)],
        sessionId: draft.sessionIds.at(-1),
      };
    }
    if (stableId.startsWith("precedent:")) {
      const doc = findKnowledgeDocByRelativePath(
        [this.runtime.workspaceRoot],
        stableId.slice("precedent:".length),
      );
      return doc ? mapKnowledgeDoc(doc, 0.4, ["stable_id"]) : undefined;
    }
    return undefined;
  }

  private resolveTapeStableId(
    stableId: string,
    candidateDigests: readonly RecallSessionDigest[],
    scope: RecallScope,
  ): RecallSearchEntry | undefined {
    const encoded = stableId.slice("tape:".length);
    const splitIndex = encoded.lastIndexOf(":");
    if (splitIndex <= 0 || splitIndex >= encoded.length - 1) {
      return undefined;
    }
    const sessionId = encoded.slice(0, splitIndex);
    const eventId = encoded.slice(splitIndex + 1);
    const digest = candidateDigests.find((entry) => entry.sessionId === sessionId);
    if (!digest) {
      return undefined;
    }
    const event = this.runtime.inspect.events
      .list(sessionId)
      .find((candidate) => candidate.id === eventId);
    if (!event) {
      return undefined;
    }
    const text = extractEventSearchText(event);
    return {
      stableId,
      sourceFamily: "tape_evidence",
      scope,
      score: 0.4,
      title: renderEventTitle(event),
      summary: compactText(text, 160),
      excerpt: compactText(text, 220),
      freshness: freshnessFromTimestamp(event.timestamp),
      matchReasons: ["stable_id"],
      sessionId: digest.sessionId,
      targetRoots: digest.targetRoots,
    };
  }
}

export function getOrCreateRecallBroker(runtime: RecallBrokerRuntime): RecallBroker {
  const key = runtime as unknown as object;
  const existing = brokerByRuntime.get(key);
  if (existing) {
    return existing;
  }
  const created = new RecallBroker(runtime);
  brokerByRuntime.set(key, created);
  return created;
}
