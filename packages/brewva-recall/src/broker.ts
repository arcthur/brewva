import {
  getOrCreateDeliberationMemoryPlane,
  getOrCreateNarrativeMemoryPlane,
  getOrCreateOptimizationContinuityPlane,
  uniqueStrings,
  type DeliberationMemoryArtifact,
  type NarrativeMemoryRecord,
  type OptimizationLineageArtifact,
} from "@brewva/brewva-deliberation";
import {
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_UTILITY_OBSERVED_EVENT_TYPE,
  type BrewvaEventRecord,
  type BrewvaInspectionPort,
} from "@brewva/brewva-runtime";
import { tokenizeSearchText } from "@brewva/brewva-search";
import {
  SESSION_INDEX_UNAVAILABLE,
  createSessionIndex,
  type SessionIndex,
  type SessionIndexDigest,
  type SessionIndexTapeEvidence,
} from "@brewva/brewva-session-index";
import {
  getOrCreateSkillPromotionBroker,
  type SkillPromotionDraft,
} from "@brewva/brewva-skill-broker";
import {
  isKernelTruthRecallTapeEvent,
  isRecallSearchableTapeEvent,
  isStrongRecallTapeEvent,
} from "./evidence-events.js";
import {
  executeKnowledgeSearch,
  findKnowledgeDocByRelativePath,
  type KnowledgeDocRecord,
} from "./knowledge-search-core.js";
import {
  RECALL_CURATION_HALFLIFE_DAYS,
  RECALL_BROKER_STATE_SCHEMA,
  type RecallBrokerState,
  type RecallCurationAggregate,
  type RecallInspectResult,
  type RecallEvidenceStrength,
  type RecallFreshness,
  type RecallScope,
  type RecallCurationSnapshot,
  type RecallSearchEntry,
  type RecallSearchIntent,
  type RecallSearchResult,
  type RecallSessionDigest,
  type RecallTrustLabel,
} from "./types.js";

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MAX_TAPE_SESSIONS = 6;
const DEFAULT_SCOPE: RecallScope = "user_repository_root";
const RECALL_CURATION_HALFLIFE_MS = RECALL_CURATION_HALFLIFE_DAYS * 24 * 60 * 60 * 1000;
const EVIDENCE_STRENGTH_WEIGHT: Record<RecallEvidenceStrength, number> = {
  strong: 2.0,
  moderate: 1.0,
  weak: 0,
};

const FRESHNESS_WEIGHT: Record<RecallFreshness, number> = {
  fresh: 0.3,
  aging: 0.12,
  stale: -0.28,
  unknown: 0,
};

interface RecallRankingContext {
  currentSessionId: string;
  intent?: RecallSearchIntent;
}

interface RecallBrokerEventsPort extends Pick<
  BrewvaInspectionPort["events"],
  "listSessionIds" | "list" | "getLogPath" | "subscribe"
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
const RECALL_STATE_INVALIDATING_EVENT_TYPES = new Set<string>([
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_UTILITY_OBSERVED_EVENT_TYPE,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRecallSessionIndexUnavailable(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === SESSION_INDEX_UNAVAILABLE || error.name === "SessionIndexUnavailableError")
  );
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
  const textTokens = new Set(tokenizeSearchText(text));
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
  const parts: string[] = [event.type];
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

function classifyTapeEvent(
  event: BrewvaEventRecord,
  currentSessionId: string,
): {
  trustLabel: RecallTrustLabel;
  evidenceStrength: RecallEvidenceStrength;
} {
  if (isKernelTruthRecallTapeEvent(event)) {
    return {
      trustLabel: "Kernel truth",
      evidenceStrength: "strong",
    };
  }
  if (isStrongRecallTapeEvent(event)) {
    return {
      trustLabel: "Verified evidence",
      evidenceStrength: "strong",
    };
  }
  if (event.sessionId === currentSessionId) {
    return {
      trustLabel: "Session-local memory",
      evidenceStrength: "weak",
    };
  }
  return {
    trustLabel: "Advisory posture",
    evidenceStrength: "weak",
  };
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

function mapSessionIndexDigest(entry: SessionIndexDigest): RecallSessionDigest {
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

function mapSessionIndexEvidenceToEvent(entry: SessionIndexTapeEvidence): BrewvaEventRecord {
  return {
    id: entry.eventId,
    sessionId: entry.sessionId,
    type: entry.type,
    timestamp: entry.timestamp,
    ...(entry.turn === undefined ? {} : { turn: entry.turn }),
    payload: entry.payload as BrewvaEventRecord["payload"],
  } as BrewvaEventRecord;
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

function createRankingContext(
  currentSessionId: string,
  intent: RecallSearchIntent | undefined,
): RecallRankingContext {
  return intent ? { currentSessionId, intent } : { currentSessionId };
}

function isCurrentSessionTapeEntry(
  entry: Pick<RecallSearchEntry, "sourceFamily" | "sessionId">,
  currentSessionId: string,
): boolean {
  return entry.sourceFamily === "tape_evidence" && entry.sessionId === currentSessionId;
}

function sourceBaseWeight(
  entry: Pick<RecallSearchEntry, "sourceFamily" | "evidenceStrength" | "sessionId">,
  context: RecallRankingContext,
): number {
  if (entry.sourceFamily === "tape_evidence") {
    if (entry.evidenceStrength === "strong") return 4.2;
    return context.intent === "current_session_evidence" &&
      isCurrentSessionTapeEntry(entry, context.currentSessionId)
      ? 2.7
      : 1.7;
  }
  if (entry.sourceFamily === "repository_precedent") return 3.25;
  if (entry.sourceFamily === "promotion_draft") return 2.35;
  return 1.25;
}

function intentWeight(
  entry: Pick<RecallSearchEntry, "sourceFamily" | "evidenceStrength" | "sessionId">,
  context: RecallRankingContext,
): number {
  switch (context.intent) {
    case "repository_precedent":
      return entry.sourceFamily === "repository_precedent" ? 0.9 : 0;
    case "current_session_evidence":
      return isCurrentSessionTapeEntry(entry, context.currentSessionId) ? 0.45 : 0;
    case "durable_runtime_receipts":
      return entry.sourceFamily === "tape_evidence" && entry.evidenceStrength === "strong"
        ? 0.9
        : 0;
    case "prior_work":
    case undefined:
      return 0;
  }
  return 0;
}

function computeRankingScore(
  entry: Omit<RecallSearchEntry, "rankingScore" | "rankReasons">,
  context: RecallRankingContext,
  curationAdjustmentValue = 0,
): { rankingScore: number; rankReasons: string[] } {
  const source = sourceBaseWeight(entry, context);
  const strength = EVIDENCE_STRENGTH_WEIGHT[entry.evidenceStrength];
  const freshness = FRESHNESS_WEIGHT[entry.freshness];
  const intentBoost = intentWeight(entry, context);
  const semantic = Math.max(0, Math.min(1, entry.semanticScore));
  const rankingScore =
    source + strength + semantic + freshness + intentBoost + curationAdjustmentValue;
  const rankReasons = [
    `source:${entry.sourceFamily}`,
    `trust:${entry.trustLabel}`,
    `strength:${entry.evidenceStrength}`,
    `semantic:${semantic.toFixed(3)}`,
    `freshness:${entry.freshness}`,
  ];
  if (context.intent) {
    rankReasons.push(`intent:${context.intent}`);
  }
  if (curationAdjustmentValue !== 0) {
    rankReasons.push(`curation:${curationAdjustmentValue.toFixed(3)}`);
  }
  return {
    rankingScore: Number(rankingScore.toFixed(6)),
    rankReasons,
  };
}

function finalizeRecallEntry(
  entry: Omit<RecallSearchEntry, "rankingScore" | "rankReasons">,
  context: RecallRankingContext,
): RecallSearchEntry {
  return {
    ...entry,
    ...computeRankingScore(entry, context),
  };
}

function compareRecallSearchEntries(left: RecallSearchEntry, right: RecallSearchEntry): number {
  if (right.rankingScore !== left.rankingScore) {
    return right.rankingScore - left.rankingScore;
  }
  return left.stableId.localeCompare(right.stableId);
}

function mapNarrativeRecord(
  record: NarrativeMemoryRecord,
  score: number,
  matchReasons: string[],
  scope: RecallScope = DEFAULT_SCOPE,
  context: RecallRankingContext,
): RecallSearchEntry {
  return finalizeRecallEntry(
    {
      stableId: `narrative:${record.id}`,
      sourceFamily: "narrative_memory",
      trustLabel: "Advisory posture",
      evidenceStrength: "weak",
      scope,
      semanticScore: score,
      title: record.title,
      summary: record.summary,
      excerpt: compactText(record.content, 220),
      freshness: freshnessFromTimestamp(record.updatedAt),
      matchReasons: matchReasons.length > 0 ? matchReasons : ["retrieval_match"],
      targetRoots: record.provenance.targetRoots,
    },
    context,
  );
}

function mapDeliberationArtifact(
  artifact: DeliberationMemoryArtifact,
  score: number,
  matchReasons: string[],
  scope: RecallScope = DEFAULT_SCOPE,
  context: RecallRankingContext,
): RecallSearchEntry {
  return finalizeRecallEntry(
    {
      stableId: `deliberation:${artifact.id}`,
      sourceFamily: "deliberation_memory",
      trustLabel: "Advisory posture",
      evidenceStrength: "weak",
      scope,
      semanticScore: score,
      title: artifact.title,
      summary: artifact.summary,
      excerpt: compactText(artifact.content, 220),
      freshness: freshnessFromTimestamp(artifact.lastValidatedAt),
      matchReasons: matchReasons.length > 0 ? matchReasons : ["retrieval_match"],
      sessionId: artifact.sessionIds.at(-1),
    },
    context,
  );
}

function mapOptimizationLineage(
  artifact: OptimizationLineageArtifact,
  score: number,
  matchReasons: string[],
  scope: RecallScope = DEFAULT_SCOPE,
  context: RecallRankingContext,
): RecallSearchEntry {
  return finalizeRecallEntry(
    {
      stableId: `optimization:${artifact.id}`,
      sourceFamily: "optimization_continuity",
      trustLabel: "Advisory posture",
      evidenceStrength: "weak",
      scope,
      semanticScore: score,
      title: artifact.goal ?? artifact.loopKey,
      summary: artifact.summary,
      excerpt: compactText(artifact.summary, 220),
      freshness: freshnessFromTimestamp(artifact.lastObservedAt),
      matchReasons,
      sessionId: artifact.rootSessionId,
    },
    context,
  );
}

function mapPromotionDraft(
  draft: SkillPromotionDraft,
  queryTokens: readonly string[],
  scope: RecallScope = DEFAULT_SCOPE,
  context: RecallRankingContext,
): RecallSearchEntry | null {
  const score = computeTokenOverlap(
    queryTokens,
    `${draft.title} ${draft.summary} ${draft.rationale} ${draft.proposalText} ${draft.tags.join(" ")}`,
  );
  if (score <= 0) return null;
  return finalizeRecallEntry(
    {
      stableId: `promotion:${draft.id}`,
      sourceFamily: "promotion_draft",
      trustLabel: "Advisory posture",
      evidenceStrength: "moderate",
      scope,
      semanticScore:
        score + draft.confidenceScore * 0.25 + Math.min(0.12, draft.repeatCount * 0.04),
      title: draft.title,
      summary: draft.summary,
      excerpt: compactText(draft.proposalText, 220),
      freshness: freshnessFromTimestamp(draft.lastValidatedAt),
      matchReasons: draft.tags.slice(0, 4),
      sessionId: draft.sessionIds.at(-1),
    },
    context,
  );
}

function mapKnowledgeDoc(
  doc: KnowledgeDocRecord,
  score: number,
  matchReasons: string[],
  scope: RecallScope = DEFAULT_SCOPE,
  context: RecallRankingContext,
): RecallSearchEntry {
  return finalizeRecallEntry(
    {
      stableId: `precedent:${doc.relativePath}`,
      sourceFamily: "repository_precedent",
      trustLabel: "Repository precedent",
      evidenceStrength: "moderate",
      scope,
      semanticScore: score,
      title: doc.title,
      summary: `${doc.sourceType} @ ${doc.relativePath}`,
      excerpt: doc.excerpt,
      freshness: doc.freshness,
      matchReasons,
      relativePath: doc.relativePath,
    },
    context,
  );
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
      workspaceRoot: runtime.workspaceRoot,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    runtime.inspect.events.subscribe((event) => {
      if (
        isRecallSearchableTapeEvent(event) ||
        RECALL_STATE_INVALIDATING_EVENT_TYPES.has(event.type) ||
        event.type.startsWith("skill_promotion_")
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
    const queryTokens = tokenizeSearchText(query, { includeCompoundSubtokens: false });
    const curationById = new Map(state.curation.map((entry) => [entry.stableId, entry]));
    const currentTarget = this.runtime.inspect.task.getTargetDescriptor(input.sessionId);
    const targetRoots =
      currentTarget.roots.length > 0 ? currentTarget.roots : [currentTarget.primaryRoot];
    const sessionIndex = await this.indexPromise;
    const tapeCandidateDigests = (
      await sessionIndex.querySessionDigests({
        currentSessionId: input.sessionId,
        scope,
        targetRoots,
        queryTokens,
        limit: Math.max(DEFAULT_MAX_TAPE_SESSIONS, limit * 2),
      })
    ).map(mapSessionIndexDigest);

    const results: RecallSearchEntry[] = [];
    results.push(
      ...(await this.searchTapeEvidence(
        tapeCandidateDigests,
        rankingContext,
        queryTokens,
        scope,
        limit,
      )),
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
            rankingContext,
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
            rankingContext,
          ),
        ),
    );
    const optimizationEntries = getOrCreateOptimizationContinuityPlane(this.runtime).retrieve(
      query,
      limit,
    );
    const promotionDrafts = getOrCreateSkillPromotionBroker(this.runtime).list({ limit });
    const scopedSessionIds = await this.filterSessionIdsByScope(
      sessionIndex,
      input.sessionId,
      scope,
      targetRoots,
      uniqueStrings([
        ...optimizationEntries
          .map((entry) => entry.artifact.rootSessionId ?? "")
          .filter((sessionId) => sessionId.length > 0),
        ...promotionDrafts.flatMap((draft) => draft.sessionIds),
      ]),
    );
    results.push(
      ...optimizationEntries
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
            rankingContext,
          ),
        ),
    );
    results.push(
      ...promotionDrafts
        .filter(
          (draft) =>
            scope === "workspace_wide" ||
            draft.sessionIds.some((sessionId) => scopedSessionIds.has(sessionId)),
        )
        .map((draft) => mapPromotionDraft(draft, queryTokens, scope, rankingContext))
        .filter((entry): entry is RecallSearchEntry => Boolean(entry)),
    );
    results.push(
      ...executeKnowledgeSearch([this.runtime.workspaceRoot], { query, limit }).results.map(
        (entry) =>
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
    const currentTarget = this.runtime.inspect.task.getTargetDescriptor(input.sessionId);
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
    queryTokens: readonly string[],
    scope: RecallScope,
    limit: number,
  ): Promise<RecallSearchEntry[]> {
    const { currentSessionId } = rankingContext;
    const rankedDigests = candidateDigests.slice(0, Math.max(DEFAULT_MAX_TAPE_SESSIONS, limit * 2));

    const sessionIndex = await this.indexPromise;
    const evidenceRows = await sessionIndex.queryTapeEvidence({
      sessionIds: rankedDigests.map((entry) => entry.sessionId),
      queryTokens,
      limit: Math.max(DEFAULT_MAX_TAPE_SESSIONS, limit * 4),
    });
    const digestBySessionId = new Map(rankedDigests.map((entry) => [entry.sessionId, entry]));
    const results: RecallSearchEntry[] = [];
    for (const evidence of evidenceRows) {
      const digest = digestBySessionId.get(evidence.sessionId);
      if (!digest) continue;
      const event = mapSessionIndexEvidenceToEvent(evidence);
      if (!isRecallSearchableTapeEvent(event)) continue;
      const text = evidence.searchText || extractEventSearchText(event);
      const overlap = evidence.tokenScore;
      if (overlap <= 0) continue;
      const classification = classifyTapeEvent(event, currentSessionId);
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
    if (stableId.startsWith("narrative:")) {
      const record = getOrCreateNarrativeMemoryPlane(this.runtime).getRecord(
        stableId.slice("narrative:".length),
      );
      return record
        ? mapNarrativeRecord(record, 0.4, ["stable_id"], scope, rankingContext)
        : undefined;
    }
    if (stableId.startsWith("deliberation:")) {
      const artifact = getOrCreateDeliberationMemoryPlane(this.runtime).getArtifact(
        stableId.slice("deliberation:".length),
      );
      return artifact
        ? mapDeliberationArtifact(artifact, 0.4, ["stable_id"], scope, rankingContext)
        : undefined;
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
        !(await this.isSessionInScope(
          sessionIndex,
          lineage.rootSessionId,
          targetRoots,
          scope,
          rankingContext,
        ))
      ) {
        return undefined;
      }
      return mapOptimizationLineage(
        lineage,
        0.4,
        uniqueStrings([lineage.status, lineage.loopKey, "stable_id"]).slice(0, 4),
        scope,
        rankingContext,
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
        (
          await this.filterSessionIdsByScope(
            sessionIndex,
            rankingContext.currentSessionId,
            scope,
            targetRoots,
            draft.sessionIds,
          )
        ).size === 0
      ) {
        return undefined;
      }
      return finalizeRecallEntry(
        {
          stableId: `promotion:${draft.id}`,
          sourceFamily: "promotion_draft",
          trustLabel: "Advisory posture",
          evidenceStrength: "moderate",
          scope,
          semanticScore: 0.4,
          title: draft.title,
          summary: draft.summary,
          excerpt: compactText(draft.proposalText, 220),
          freshness: freshnessFromTimestamp(draft.lastValidatedAt),
          matchReasons: ["stable_id", ...draft.tags.slice(0, 3)],
          sessionId: draft.sessionIds.at(-1),
        },
        rankingContext,
      );
    }
    if (stableId.startsWith("precedent:")) {
      const doc = findKnowledgeDocByRelativePath(
        [this.runtime.workspaceRoot],
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
    const encoded = stableId.slice("tape:".length);
    const splitIndex = encoded.lastIndexOf(":");
    if (splitIndex <= 0 || splitIndex >= encoded.length - 1) {
      return undefined;
    }
    const sessionId = encoded.slice(0, splitIndex);
    const eventId = encoded.slice(splitIndex + 1);
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
    if (!isRecallSearchableTapeEvent(event)) {
      return undefined;
    }
    const text = evidence.searchText || extractEventSearchText(event);
    const classification = classifyTapeEvent(event, rankingContext.currentSessionId);
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
  const key = runtime as unknown as object;
  const existing = brokerByRuntime.get(key);
  if (existing) {
    return existing;
  }
  const created = new RecallBroker(runtime);
  brokerByRuntime.set(key, created);
  return created;
}
