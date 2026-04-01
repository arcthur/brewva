import { randomUUID } from "node:crypto";
import type { BrewvaRuntime, ContextSourceProvider } from "@brewva/brewva-runtime";
import { CONTEXT_SOURCES } from "@brewva/brewva-runtime";
import { FileNarrativeMemoryStore } from "./narrative-store.js";
import {
  NARRATIVE_MEMORY_RECORD_CLASSES,
  NARRATIVE_MEMORY_RETRIEVABLE_STATUSES,
  NARRATIVE_MEMORY_SCOPE_VALUES,
  NARRATIVE_MEMORY_STATE_SCHEMA,
  type NarrativeMemoryEvidence,
  type NarrativeMemoryPromotionTarget,
  type NarrativeMemoryProvenance,
  type NarrativeMemoryRecord,
  type NarrativeMemoryRecordClass,
  type NarrativeMemoryRecordStatus,
  type NarrativeMemoryRetrieval,
  type NarrativeMemoryState,
} from "./narrative-types.js";
import { clamp, tokenize, uniqueStrings } from "./plane-substrate.js";

const DEFAULT_MAX_RETRIEVAL = 4;
const DEFAULT_CONTEXT_RECORDS = 3;

type NarrativeMemoryRuntime = Pick<BrewvaRuntime, "workspaceRoot" | "agentId" | "task">;

const planeByRuntime = new WeakMap<object, NarrativeMemoryPlane>();

function compactText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function compactStructuredText(value: string, maxChars: number): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function normalizeEvidence(
  evidence: readonly NarrativeMemoryEvidence[],
): NarrativeMemoryEvidence[] {
  const byKey = new Map<string, NarrativeMemoryEvidence>();
  for (const entry of evidence) {
    const key = [
      entry.kind,
      entry.sessionId,
      entry.eventId ?? "",
      entry.toolName ?? "",
      entry.summary.trim(),
    ].join(":");
    byKey.set(key, {
      ...entry,
      summary: compactText(entry.summary, 240),
    });
  }
  return [...byKey.values()].toSorted(
    (left, right) => right.timestamp - left.timestamp || left.summary.localeCompare(right.summary),
  );
}

function normalizeRecord(input: {
  id?: string;
  class: NarrativeMemoryRecordClass;
  title: string;
  summary: string;
  content: string;
  applicabilityScope: NarrativeMemoryRecord["applicabilityScope"];
  confidenceScore: number;
  status: NarrativeMemoryRecordStatus;
  createdAt?: number;
  updatedAt?: number;
  retrievalCount?: number;
  lastRetrievedAt?: number;
  provenance: NarrativeMemoryProvenance;
  evidence: readonly NarrativeMemoryEvidence[];
  promotionTarget?: NarrativeMemoryPromotionTarget;
  metadata?: Record<string, unknown>;
}): NarrativeMemoryRecord {
  const createdAt = input.createdAt ?? Date.now();
  const updatedAt = input.updatedAt ?? createdAt;
  return {
    id: input.id?.trim() || `narrative-${randomUUID()}`,
    class: input.class,
    title: compactText(input.title, 120),
    summary: compactText(input.summary, 220),
    content: compactStructuredText(input.content, 1_400),
    applicabilityScope: input.applicabilityScope,
    confidenceScore: clamp(input.confidenceScore, 0, 1),
    status: input.status,
    createdAt,
    updatedAt,
    retrievalCount: Math.max(0, Math.trunc(input.retrievalCount ?? 0)),
    lastRetrievedAt: input.lastRetrievedAt,
    provenance: {
      ...input.provenance,
      targetRoots: uniqueStrings(input.provenance.targetRoots),
    },
    evidence: normalizeEvidence(input.evidence).slice(0, 16),
    promotionTarget: input.promotionTarget,
    metadata: input.metadata,
  };
}

function formatIsoTimestamp(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toISOString() : "none";
}

function resolveFreshnessHint(updatedAt: number): string {
  const ageMs = Math.max(0, Date.now() - updatedAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1_000);
  if (ageDays <= 7) {
    return "recent";
  }
  if (ageDays <= 45) {
    return "aging";
  }
  return "stale";
}

function createEmptyNarrativeMemoryState(): NarrativeMemoryState {
  return {
    schema: NARRATIVE_MEMORY_STATE_SCHEMA,
    updatedAt: Date.now(),
    records: [],
  };
}

function computeJaccardScore(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
}

function computeTargetRootScore(
  record: NarrativeMemoryRecord,
  targetRoots: readonly string[],
): number {
  if (targetRoots.length === 0 || record.provenance.targetRoots.length === 0) {
    return 0;
  }
  const targetSet = new Set(targetRoots.map((root) => root.trim()).filter(Boolean));
  let matches = 0;
  for (const root of record.provenance.targetRoots) {
    if (targetSet.has(root)) {
      matches += 1;
    }
  }
  return matches > 0 ? Math.min(0.2, matches / Math.max(1, targetSet.size) / 2) : 0;
}

function computeScopeScore(record: NarrativeMemoryRecord): number {
  switch (record.applicabilityScope) {
    case "operator":
      return 0.1;
    case "agent":
      return 0.08;
    case "repository":
      return 0.06;
    default:
      return 0;
  }
}

function computeClassScore(record: NarrativeMemoryRecord): number {
  switch (record.class) {
    case "operator_preference":
      return 0.12;
    case "working_convention":
      return 0.1;
    case "project_context_note":
      return 0.08;
    case "external_reference_note":
      return 0.06;
    default:
      return 0;
  }
}

function tokenizeRecord(record: NarrativeMemoryRecord): string[] {
  return uniqueStrings(
    tokenize(
      [
        record.class,
        record.applicabilityScope,
        record.title,
        record.summary,
        record.content,
        ...record.provenance.targetRoots,
      ].join(" "),
    ),
  );
}

function computeRetrievals(input: {
  records: readonly NarrativeMemoryRecord[];
  query: string;
  limit: number;
  targetRoots: readonly string[];
  statuses: readonly NarrativeMemoryRecordStatus[];
}): NarrativeMemoryRetrieval[] {
  const queryTokens = uniqueStrings(tokenize(input.query));
  if (queryTokens.length === 0) {
    return [];
  }
  const allowedStatuses = new Set(input.statuses);
  return input.records
    .filter((record) => allowedStatuses.has(record.status))
    .map((record) => {
      const recordTokens = tokenizeRecord(record);
      const matchedTerms = queryTokens.filter((token) => recordTokens.includes(token));
      const lexicalScore = computeJaccardScore(queryTokens, recordTokens);
      const score =
        lexicalScore +
        record.confidenceScore * 0.22 +
        computeScopeScore(record) +
        computeClassScore(record) +
        computeTargetRootScore(record, input.targetRoots) +
        Math.min(0.08, record.retrievalCount * 0.01);
      return {
        record,
        score,
        matchedTerms,
      };
    })
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.record.updatedAt - left.record.updatedAt;
    })
    .slice(0, Math.max(1, input.limit));
}

function renderContextRecord(record: NarrativeMemoryRecord): string {
  return [
    "[NarrativeMemory]",
    `id: ${record.id}`,
    `class: ${record.class}`,
    `scope: ${record.applicabilityScope}`,
    `provenance_source: ${record.provenance.source}`,
    `provenance_actor: ${record.provenance.actor}`,
    `updated_at: ${formatIsoTimestamp(record.updatedAt)}`,
    `last_retrieved_at: ${formatIsoTimestamp(record.lastRetrievedAt)}`,
    `freshness: ${resolveFreshnessHint(record.updatedAt)}`,
    "verify_before_applying: yes",
    `title: ${record.title}`,
    `summary: ${record.summary}`,
    `content: ${record.content}`,
  ].join("\n");
}

export function createNarrativeMemoryRecordId(prefix = "narrative"): string {
  return `${prefix}-${randomUUID()}`;
}

export function createEmptyNarrativeMemoryRecord(input: {
  class: NarrativeMemoryRecordClass;
  title: string;
  summary: string;
  content: string;
  applicabilityScope: NarrativeMemoryRecord["applicabilityScope"];
  confidenceScore: number;
  status: NarrativeMemoryRecordStatus;
  provenance: NarrativeMemoryProvenance;
  evidence: readonly NarrativeMemoryEvidence[];
  metadata?: Record<string, unknown>;
}): NarrativeMemoryRecord {
  return normalizeRecord({
    ...input,
    id: createNarrativeMemoryRecordId(),
  });
}

export function resolveNarrativeMemoryHeadingForClass(
  recordClass: NarrativeMemoryRecordClass,
): string {
  switch (recordClass) {
    case "operator_preference":
      return "Operator Preferences";
    case "working_convention":
      return "Stable Memory";
    case "project_context_note":
    case "external_reference_note":
      return "Continuity Notes";
    default:
      return "Continuity Notes";
  }
}

export class NarrativeMemoryPlane {
  private readonly store: FileNarrativeMemoryStore;
  private state: NarrativeMemoryState;

  constructor(
    private readonly runtime: NarrativeMemoryRuntime,
    options: { workspaceRoot?: string } = {},
  ) {
    this.store = new FileNarrativeMemoryStore(options.workspaceRoot ?? runtime.workspaceRoot);
    this.state = this.store.read() ?? createEmptyNarrativeMemoryState();
  }

  sync(): NarrativeMemoryState {
    this.state = this.store.read() ?? this.state ?? createEmptyNarrativeMemoryState();
    return this.state;
  }

  getState(): NarrativeMemoryState {
    return this.sync();
  }

  list(
    options: {
      class?: NarrativeMemoryRecord["class"];
      status?: NarrativeMemoryRecord["status"];
      applicabilityScope?: NarrativeMemoryRecord["applicabilityScope"];
      limit?: number;
    } = {},
  ): NarrativeMemoryRecord[] {
    return this.filterRecords(this.sync().records, options);
  }

  getRecord(recordId: string): NarrativeMemoryRecord | undefined {
    const normalizedId = recordId.trim();
    if (!normalizedId) return undefined;
    return this.sync().records.find((record) => record.id === normalizedId);
  }

  addRecord(
    input: Omit<NarrativeMemoryRecord, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): NarrativeMemoryRecord {
    const state = this.sync();
    const nextRecord = normalizeRecord(input);
    if (state.records.some((record) => record.id === nextRecord.id)) {
      throw new Error(`Narrative memory record already exists: ${nextRecord.id}`);
    }
    return this.replaceState({
      ...state,
      records: [nextRecord, ...state.records].toSorted(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    }).records.find((record) => record.id === nextRecord.id)!;
  }

  updateRecord(
    recordId: string,
    updater: (current: NarrativeMemoryRecord) => NarrativeMemoryRecord,
  ): NarrativeMemoryRecord | undefined {
    const state = this.sync();
    const index = state.records.findIndex((record) => record.id === recordId.trim());
    if (index < 0) return undefined;
    const current = state.records[index];
    if (!current) return undefined;
    const next = normalizeRecord({
      ...updater(current),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    });
    const records = [...state.records];
    records[index] = next;
    return this.replaceState({
      ...state,
      records: records.toSorted((left, right) => right.updatedAt - left.updatedAt),
    }).records.find((record) => record.id === next.id);
  }

  retrieve(
    query: string,
    options: {
      limit?: number;
      targetRoots?: readonly string[];
      statuses?: readonly NarrativeMemoryRecordStatus[];
      recordRetrieval?: boolean;
    } = {},
  ): NarrativeMemoryRetrieval[] {
    const state = this.sync();
    const retrievals = computeRetrievals({
      records: state.records,
      query,
      limit: options.limit ?? DEFAULT_MAX_RETRIEVAL,
      targetRoots: options.targetRoots ?? [],
      statuses:
        options.statuses ??
        ([
          ...NARRATIVE_MEMORY_RETRIEVABLE_STATUSES,
        ] satisfies readonly NarrativeMemoryRecordStatus[]),
    });
    if (options.recordRetrieval !== false && retrievals.length > 0) {
      this.markRetrieved(retrievals.map((entry) => entry.record.id));
    }
    return retrievals;
  }

  markRetrieved(recordIds: readonly string[], timestamp = Date.now()): void {
    if (recordIds.length === 0) return;
    const idSet = new Set(recordIds.map((recordId) => recordId.trim()).filter(Boolean));
    if (idSet.size === 0) return;
    const state = this.sync();
    const records = state.records.map((record) =>
      idSet.has(record.id)
        ? normalizeRecord({
            ...record,
            updatedAt: record.updatedAt,
            retrievalCount: record.retrievalCount + 1,
            lastRetrievedAt: timestamp,
          })
        : record,
    );
    this.replaceState({
      ...state,
      records,
    });
  }

  findNearDuplicates(input: {
    class?: NarrativeMemoryRecord["class"];
    scope?: NarrativeMemoryRecord["applicabilityScope"];
    title?: string;
    content: string;
    statuses?: readonly NarrativeMemoryRecordStatus[];
    minimumScore?: number;
    excludeRecordId?: string;
  }): Array<{ record: NarrativeMemoryRecord; score: number }> {
    const state = this.sync();
    const statuses = new Set(
      input.statuses ??
        (["proposed", "active", "promoted"] satisfies readonly NarrativeMemoryRecordStatus[]),
    );
    const candidateTokens = uniqueStrings(
      tokenize([input.title ?? "", input.content].filter(Boolean).join(" ")),
    );
    if (candidateTokens.length === 0) {
      return [];
    }
    return state.records
      .filter((record) => statuses.has(record.status))
      .filter((record) => !input.class || record.class === input.class)
      .filter((record) => !input.scope || record.applicabilityScope === input.scope)
      .filter((record) => !input.excludeRecordId || record.id !== input.excludeRecordId)
      .map((record) => ({
        record,
        score: computeJaccardScore(candidateTokens, tokenizeRecord(record)),
      }))
      .filter((entry) => entry.score >= (input.minimumScore ?? 0.72))
      .toSorted(
        (left, right) => right.score - left.score || right.record.updatedAt - left.record.updatedAt,
      );
  }

  private filterRecords(
    records: readonly NarrativeMemoryRecord[],
    options: {
      class?: NarrativeMemoryRecord["class"];
      status?: NarrativeMemoryRecord["status"];
      applicabilityScope?: NarrativeMemoryRecord["applicabilityScope"];
      limit?: number;
    },
  ): NarrativeMemoryRecord[] {
    return records
      .filter((record) => !options.class || record.class === options.class)
      .filter((record) => !options.status || record.status === options.status)
      .filter(
        (record) =>
          !options.applicabilityScope || record.applicabilityScope === options.applicabilityScope,
      )
      .slice(0, Math.max(1, options.limit ?? records.length));
  }

  private replaceState(state: NarrativeMemoryState): NarrativeMemoryState {
    const nextState: NarrativeMemoryState = {
      schema: NARRATIVE_MEMORY_STATE_SCHEMA,
      updatedAt: Date.now(),
      records: state.records.toSorted((left, right) => right.updatedAt - left.updatedAt),
    };
    this.store.write(nextState);
    this.state = nextState;
    return nextState;
  }
}

export function getOrCreateNarrativeMemoryPlane(
  runtime: NarrativeMemoryRuntime,
  options: { workspaceRoot?: string } = {},
): NarrativeMemoryPlane {
  const key = runtime as unknown as object;
  const existing = planeByRuntime.get(key);
  if (existing) {
    return existing;
  }
  const created = new NarrativeMemoryPlane(runtime, options);
  planeByRuntime.set(key, created);
  return created;
}

export function createNarrativeMemoryContextProvider(input: {
  runtime: BrewvaRuntime;
  maxRecords?: number;
}): ContextSourceProvider {
  const plane = getOrCreateNarrativeMemoryPlane(input.runtime);
  return {
    source: CONTEXT_SOURCES.narrativeMemory,
    category: "narrative",
    budgetClass: "recall",
    order: 14,
    collect(providerInput) {
      const retrievals = plane.retrieve(providerInput.promptText, {
        limit: input.maxRecords ?? DEFAULT_CONTEXT_RECORDS,
        targetRoots: input.runtime.task.getTargetDescriptor(providerInput.sessionId).roots,
        statuses: ["active"],
        recordRetrieval: false,
      });
      for (const retrieval of retrievals) {
        providerInput.register({
          id: retrieval.record.id,
          content: renderContextRecord(retrieval.record),
        });
      }
    },
  };
}

export {
  DEFAULT_CONTEXT_RECORDS as DEFAULT_NARRATIVE_MEMORY_CONTEXT_RECORDS,
  DEFAULT_MAX_RETRIEVAL as DEFAULT_NARRATIVE_MEMORY_MAX_RETRIEVAL,
  NARRATIVE_MEMORY_RECORD_CLASSES,
  NARRATIVE_MEMORY_SCOPE_VALUES,
};
