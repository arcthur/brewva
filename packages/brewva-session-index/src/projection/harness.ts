import { chunkArray } from "@brewva/brewva-std/collections";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  CONTEXT_EVIDENCE_APPENDED_EVENT_TYPE,
  HARNESS_TRACE_SNAPSHOT_SCHEMA,
  SKILL_SELECTION_RECORDED_EVENT_TYPE,
  TOOL_SURFACE_RESOLVED_EVENT_TYPE,
  buildHarnessTraceSnapshotId,
  clusterHarnessTraceSnapshots,
  readHarnessManifestRecordedAdvisoryEvent,
  type HarnessManifest,
  type HarnessPatternCandidate,
  type HarnessTraceSignal,
  type HarnessTraceSnapshot,
} from "@brewva/brewva-vocabulary/harness";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import {
  outcomeVerdict,
  type BrewvaOutcome,
  type OutcomeVerdict,
} from "@brewva/brewva-vocabulary/outcome";
import { SESSION_INDEX_SCHEMA_VERSION } from "../api.js";
import type { DuckDBConnection } from "../duckdb/instance.js";
import type { JsonRow } from "../duckdb/query.js";
import { isRecord, readString } from "../json.js";
import type { SessionIndexQueryPort } from "../query/port.js";
import type { SqlParams } from "../sql/params.js";

export { clusterHarnessTraceSnapshots as clusterHarnessPatternCandidates } from "@brewva/brewva-vocabulary/harness";

export interface ProjectSessionHarnessTraceSnapshotsInput {
  readonly sessionId: string;
  readonly records: readonly BrewvaEventRecord[];
}

interface HarnessProjectionState {
  manifest: HarnessManifest;
  eventIds: Set<string>;
  updatedAt: number;
  providerFailures: Set<string>;
  providerFailureReasons: string[];
  toolCommits: Set<string>;
  toolErrors: Set<string>;
  toolInconclusive: Set<string>;
  requestedUnknownToolNames: Set<string>;
  contextUsageRatio: number | null;
  contextGateRequired: boolean;
  cacheStatus: string | null;
  cacheUnexpectedBreak: boolean;
  cacheChangedFields: Set<string>;
  skillOmittedCount: number;
  weakVerificationEventIds: Set<string>;
  outcomeStatus: string | null;
}

interface HarnessProjectionIndex {
  readonly states: HarnessProjectionState[];
  readonly sessionWide: HarnessProjectionState[];
  readonly byTurn: Map<number, HarnessProjectionState[]>;
  readonly byTurnId: Map<string, HarnessProjectionState[]>;
}

interface HarnessSnapshotRow extends JsonRow {
  snapshot_json: string;
}

export function projectSessionHarnessTraceSnapshots(
  input: ProjectSessionHarnessTraceSnapshotsInput,
): HarnessTraceSnapshot[] {
  const ordered = [...input.records].toSorted((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return left.id.localeCompare(right.id);
  });
  const index: HarnessProjectionIndex = {
    states: [],
    sessionWide: [],
    byTurn: new Map(),
    byTurnId: new Map(),
  };

  for (const record of ordered) {
    if (record.sessionId !== input.sessionId) continue;
    const manifest = readHarnessManifestEventPayload(record);
    if (manifest) {
      indexHarnessProjectionState(index, createStateFromManifestEvent(record, manifest));
      continue;
    }
    for (const state of candidateStatesForRecord(index, record)) {
      if (!recordBelongsToManifest(record, state.manifest)) continue;
      foldHarnessEvidence(state, record);
    }
  }

  return index.states.map(buildFoldedHarnessTraceSnapshot);
}

export async function rebuildSessionHarnessProjection(input: {
  readonly connection: DuckDBConnection;
  readonly sessionId: string;
  readonly records: readonly BrewvaEventRecord[];
}): Promise<void> {
  const snapshots = projectSessionHarnessTraceSnapshots({
    sessionId: input.sessionId,
    records: input.records,
  });
  await input.connection.run(
    "delete from session_harness_trace_snapshots where session_id = $sessionId",
    { sessionId: input.sessionId },
  );
  await insertHarnessTraceSnapshots(input.connection, snapshots);
}

export async function listHarnessTraceSnapshotRows(input: {
  readonly port: SessionIndexQueryPort;
  readonly sessionId?: string;
  readonly limit?: number;
}): Promise<HarnessTraceSnapshot[]> {
  await input.port.ensureAvailable();
  const limit = Math.max(1, Math.min(500, input.limit ?? 50));
  const rows = await input.port.selectRows<HarnessSnapshotRow>(
    `
      select snapshot_json
      from session_harness_trace_snapshots
      where ($sessionId is null or session_id = $sessionId)
      order by updated_at desc, snapshot_id asc
      limit $limit
    `,
    { sessionId: input.sessionId ?? null, limit },
  );
  return rows.map((row) => JSON.parse(row.snapshot_json) as HarnessTraceSnapshot);
}

export async function getHarnessTraceSnapshotRow(input: {
  readonly port: SessionIndexQueryPort;
  readonly snapshotId: string;
}): Promise<HarnessTraceSnapshot | undefined> {
  await input.port.ensureAvailable();
  const row = await input.port.selectOne<HarnessSnapshotRow>(
    `
      select snapshot_json
      from session_harness_trace_snapshots
      where snapshot_id = $snapshotId
      limit 1
    `,
    { snapshotId: input.snapshotId },
  );
  return row ? (JSON.parse(row.snapshot_json) as HarnessTraceSnapshot) : undefined;
}

export async function listHarnessPatternCandidateRows(input: {
  readonly port: SessionIndexQueryPort;
  readonly sessionId?: string;
  readonly minOccurrences?: number;
  readonly limit?: number;
}): Promise<HarnessPatternCandidate[]> {
  const candidateLimit = Math.max(1, Math.min(500, input.limit ?? 50));
  const snapshotWindow = Math.max(candidateLimit, 100);
  await input.port.ensureAvailable();
  const rows = await input.port.selectRows<HarnessSnapshotRow>(
    `
      select snapshot_json
      from session_harness_trace_snapshots
      where ($sessionId is null or session_id = $sessionId)
        and signal_kinds_json <> '[]'
      order by updated_at desc, snapshot_id asc
      limit $limit
    `,
    { sessionId: input.sessionId ?? null, limit: snapshotWindow },
  );
  const snapshots = rows.map((row) => JSON.parse(row.snapshot_json) as HarnessTraceSnapshot);
  return clusterHarnessTraceSnapshots(snapshots, {
    minOccurrences: input.minOccurrences ?? 2,
  }).slice(0, candidateLimit);
}

function readHarnessManifestEventPayload(record: BrewvaEventRecord): HarnessManifest | undefined {
  return readHarnessManifestRecordedAdvisoryEvent(record);
}

function createStateFromManifestEvent(
  record: BrewvaEventRecord,
  manifest: HarnessManifest,
): HarnessProjectionState {
  return {
    manifest,
    eventIds: new Set([record.id, ...(manifest.refs?.sourceEventIds ?? [])]),
    updatedAt: record.timestamp,
    providerFailures: new Set(
      manifest.provider?.status === "failed" || manifest.provider?.failureClass ? [record.id] : [],
    ),
    providerFailureReasons: manifest.provider?.failureClass
      ? [`provider_failure:${manifest.provider.failureClass}`]
      : [],
    toolCommits: new Set(),
    toolErrors: new Set(),
    toolInconclusive: new Set(),
    requestedUnknownToolNames: new Set(),
    contextUsageRatio: null,
    contextGateRequired: false,
    cacheStatus: null,
    cacheUnexpectedBreak: false,
    cacheChangedFields: new Set(),
    skillOmittedCount: manifest.skillSelection?.selectionId ? 0 : 1,
    weakVerificationEventIds: new Set(),
    outcomeStatus: null,
  };
}

function indexHarnessProjectionState(
  index: HarnessProjectionIndex,
  state: HarnessProjectionState,
): void {
  index.states.push(state);
  if (state.manifest.turnId) {
    pushIndexedState(index.byTurnId, state.manifest.turnId, state);
  }
  if (state.manifest.turn !== undefined) {
    pushIndexedState(index.byTurn, state.manifest.turn, state);
  }
  if (!state.manifest.turnId && state.manifest.turn === undefined) {
    index.sessionWide.push(state);
  }
}

function pushIndexedState<K>(
  index: Map<K, HarnessProjectionState[]>,
  key: K,
  state: HarnessProjectionState,
): void {
  const bucket = index.get(key) ?? [];
  bucket.push(state);
  index.set(key, bucket);
}

function candidateStatesForRecord(
  index: HarnessProjectionIndex,
  record: BrewvaEventRecord,
): readonly HarnessProjectionState[] {
  if (record.turnId === undefined && record.turn === undefined) {
    return index.states;
  }
  const candidates = new Set<HarnessProjectionState>(index.sessionWide);
  if (record.turnId) {
    for (const state of index.byTurnId.get(record.turnId) ?? []) candidates.add(state);
  }
  if (record.turn !== undefined) {
    for (const state of index.byTurn.get(record.turn) ?? []) candidates.add(state);
  }
  return [...candidates];
}

function recordBelongsToManifest(record: BrewvaEventRecord, manifest: HarnessManifest): boolean {
  if (record.sessionId !== manifest.sessionId) return false;
  if (manifest.turn !== undefined && record.turn !== undefined && record.turn !== manifest.turn) {
    return false;
  }
  if (
    manifest.turnId !== undefined &&
    record.turnId !== undefined &&
    record.turnId !== manifest.turnId
  ) {
    return false;
  }
  return true;
}

function foldHarnessEvidence(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  switch (record.type) {
    case CONTEXT_EVIDENCE_APPENDED_EVENT_TYPE:
      foldContextEvidence(state, record);
      return;
    case "tool.committed":
      foldToolCommitted(state, record);
      return;
    case "runtime.suspended":
      foldRuntimeSuspended(state, record);
      return;
    case "turn.ended":
      foldTurnEnded(state, record);
      return;
    case TOOL_SURFACE_RESOLVED_EVENT_TYPE:
      foldToolSurface(state, record);
      return;
    case SKILL_SELECTION_RECORDED_EVENT_TYPE:
      foldSkillSelection(state, record);
      return;
    case VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE:
      foldVerificationOutcome(state, record);
      return;
    case VERIFICATION_WRITE_MARKED_EVENT_TYPE:
      foldVerificationWriteMarked(state, record);
      return;
    default:
      return;
  }
}

function foldContextEvidence(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  addStateEvent(state, record);
  const payload = isRecord(record.payload) ? record.payload : {};
  const nested = isRecord(payload.payload) ? payload.payload : payload;
  const status = readString(nested.status);
  if (status) {
    state.cacheStatus = status;
  }
  if (status === "break" && readString(nested.classification) === "unexpected") {
    state.cacheUnexpectedBreak = true;
  }
  const changedFields = Array.isArray(nested.changedFields) ? nested.changedFields : [];
  for (const field of changedFields) {
    if (typeof field === "string" && field.length > 0) state.cacheChangedFields.add(field);
  }
  const usageRatio = readFiniteNumber(nested.usageRatio ?? nested.contextUsageRatio);
  if (usageRatio !== null) {
    state.contextUsageRatio = Math.max(state.contextUsageRatio ?? 0, usageRatio);
  }
  if (nested.gateRequired === true || readString(nested.status) === "critical") {
    state.contextGateRequired = true;
  }
}

function foldToolCommitted(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  addStateEvent(state, record);
  state.toolCommits.add(record.id);
  const payload = isRecord(record.payload) ? record.payload : {};
  const result = isRecord(payload.result) ? payload.result : {};
  const verdict = readToolOutcomeVerdict(result.outcome);
  if (verdict === "fail") {
    state.toolErrors.add(record.id);
  }
  if (verdict === "inconclusive") {
    state.toolInconclusive.add(record.id);
  }
  const call = isRecord(payload.call) ? payload.call : {};
  const toolName = readString(call.toolName) ?? readString(call.name);
  if (toolName && !state.manifest.tools?.activeToolNames?.includes(toolName)) {
    state.requestedUnknownToolNames.add(toolName);
  }
}

function foldRuntimeSuspended(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  addStateEvent(state, record);
  const payload = isRecord(record.payload) ? record.payload : {};
  const cause = readString(payload.cause) ?? "";
  if (cause === "provider_retry") {
    state.providerFailures.add(record.id);
    state.providerFailureReasons.push(`provider_failure:${cause}`);
  }
}

function foldTurnEnded(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  addStateEvent(state, record);
  const payload = isRecord(record.payload) ? record.payload : {};
  state.outcomeStatus = readTurnEndedStatus(payload.status) ?? state.outcomeStatus;
}

function foldToolSurface(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  addStateEvent(state, record);
  const payload = isRecord(record.payload) ? record.payload : {};
  const missing = Array.isArray(payload.requestedUnknownToolNames)
    ? payload.requestedUnknownToolNames
    : [];
  for (const name of missing) {
    if (typeof name === "string" && name.length > 0) state.requestedUnknownToolNames.add(name);
  }
}

function foldSkillSelection(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  addStateEvent(state, record);
  const payload = isRecord(record.payload) ? record.payload : {};
  const omittedCount = readFiniteNumber(payload.omittedCount);
  if (omittedCount !== null) {
    state.skillOmittedCount = Math.max(state.skillOmittedCount, omittedCount);
  }
}

function foldVerificationOutcome(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  addStateEvent(state, record);
  const verification = readVerificationOutcomeRecordedEventPayload(record);
  if (
    verification.outcome !== "pass" ||
    verification.evidenceFreshness === "stale" ||
    verification.failedChecks.length > 0 ||
    verification.missingChecks.length > 0 ||
    verification.missingEvidence.length > 0
  ) {
    state.weakVerificationEventIds.add(record.id);
  }
}

function foldVerificationWriteMarked(
  state: HarnessProjectionState,
  record: BrewvaEventRecord,
): void {
  addStateEvent(state, record);
  state.weakVerificationEventIds.add(record.id);
}

function buildFoldedHarnessTraceSnapshot(state: HarnessProjectionState): HarnessTraceSnapshot {
  const signals = buildSignals(state);
  const eventIds = [...state.eventIds].toSorted();
  const snapshotId = buildHarnessTraceSnapshotId({
    sessionId: state.manifest.sessionId,
    ...(state.manifest.turn === undefined ? {} : { turn: state.manifest.turn }),
    ...(state.manifest.turnId === undefined ? {} : { turnId: state.manifest.turnId }),
    attempt: state.manifest.attempt,
    manifestId: state.manifest.manifestId,
  });
  return {
    schema: HARNESS_TRACE_SNAPSHOT_SCHEMA,
    snapshotId,
    sessionId: state.manifest.sessionId,
    ...(state.manifest.turn === undefined ? {} : { turn: state.manifest.turn }),
    ...(state.manifest.turnId === undefined ? {} : { turnId: state.manifest.turnId }),
    attempt: state.manifest.attempt,
    manifestId: state.manifest.manifestId,
    eventIds,
    updatedAt: state.updatedAt,
    manifest: state.manifest,
    provider: {
      provider: state.manifest.provider?.provider,
      api: state.manifest.provider?.api,
      model: state.manifest.provider?.model,
      attempts: 1,
      failures: state.providerFailures.size,
      fallbackActive: state.manifest.provider?.providerFallbackActive ?? false,
    },
    context: {
      usageRatio: state.contextUsageRatio,
      gateRequired: state.contextGateRequired,
    },
    cache: {
      status: state.cacheStatus,
      unexpectedBreak: state.cacheUnexpectedBreak,
      changedFields: [...state.cacheChangedFields].toSorted(),
    },
    skills: {
      selectionId: state.manifest.skillSelection?.selectionId ?? null,
      selectedSkillIds: state.manifest.skillSelection?.selectedSkillIds ?? [],
      omittedCount: state.skillOmittedCount,
    },
    tools: {
      activeToolNames: state.manifest.tools?.activeToolNames ?? [],
      requestedUnknownToolNames: [...state.requestedUnknownToolNames].toSorted(),
      committed: state.toolCommits.size,
      errors: state.toolErrors.size,
      inconclusive: state.toolInconclusive.size,
    },
    verification: {
      weakEvidence: state.weakVerificationEventIds.size > 0,
    },
    outcome: {
      status: state.outcomeStatus,
    },
    signals,
  };
}

function buildSignals(state: HarnessProjectionState): HarnessTraceSignal[] {
  const signals: HarnessTraceSignal[] = [];
  if (state.providerFailures.size > 0) {
    signals.push({
      kind: "provider_failure",
      severity: "high",
      reason: state.providerFailureReasons[0] ?? "provider_failure:detected",
      eventIds: [...state.providerFailures].toSorted(),
    });
  }
  if (state.toolErrors.size > 0 || state.toolInconclusive.size > 0) {
    const eventIds = new Set([...state.toolErrors, ...state.toolInconclusive]);
    signals.push({
      kind: "tool_contract",
      severity: "medium",
      reason:
        state.toolErrors.size > 0
          ? "tool_contract:error_outcome"
          : "tool_contract:inconclusive_outcome",
      eventIds: [...eventIds].toSorted(),
    });
  }
  if ((state.contextUsageRatio ?? 0) >= 0.9 || state.contextGateRequired) {
    signals.push({
      kind: "context_pressure",
      severity: "medium",
      reason: "context_pressure:budget_or_gate",
      eventIds: [...state.eventIds].toSorted(),
    });
  }
  if (state.skillOmittedCount > 0) {
    signals.push({
      kind: "skill_surface_miss",
      severity: "medium",
      reason: "skill_surface_miss:selection_missing_or_omitted",
      eventIds: [...state.eventIds].toSorted(),
    });
  }
  if (state.requestedUnknownToolNames.size > 0) {
    signals.push({
      kind: "tool_surface_miss",
      severity: "medium",
      reason: "tool_surface_miss:unknown_tool_requested",
      eventIds: [...state.eventIds].toSorted(),
    });
  }
  if (state.weakVerificationEventIds.size > 0) {
    signals.push({
      kind: "verification_hygiene",
      severity: "medium",
      reason: "verification_hygiene:weak_evidence",
      eventIds: [...state.weakVerificationEventIds].toSorted(),
    });
  }
  if (state.cacheUnexpectedBreak) {
    signals.push({
      kind: "cache_regression",
      severity: "medium",
      reason: "cache_regression:unexpected_provider_cache_break",
      eventIds: [...state.eventIds].toSorted(),
    });
  }
  return signals.toSorted((left, right) => left.kind.localeCompare(right.kind));
}

async function insertHarnessTraceSnapshots(
  connection: DuckDBConnection,
  snapshots: readonly HarnessTraceSnapshot[],
): Promise<void> {
  for (const chunk of chunkArray(snapshots, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((snapshot, index) => {
      params[`snapshotId${index}`] = snapshot.snapshotId;
      params[`sessionId${index}`] = snapshot.sessionId;
      params[`turn${index}`] = snapshot.turn ?? null;
      params[`turnId${index}`] = snapshot.turnId ?? null;
      params[`attempt${index}`] = snapshot.attempt;
      params[`manifestId${index}`] = snapshot.manifestId;
      params[`eventIdsJson${index}`] = JSON.stringify(snapshot.eventIds);
      params[`signalKindsJson${index}`] = JSON.stringify(
        snapshot.signals.map((signal) => signal.kind),
      );
      params[`manifestJson${index}`] = JSON.stringify(snapshot.manifest ?? {});
      params[`snapshotJson${index}`] = JSON.stringify(snapshot);
      params[`updatedAt${index}`] = String(snapshot.updatedAt ?? 0);
      params[`schemaVersion${index}`] = SESSION_INDEX_SCHEMA_VERSION;
      return `(
        $snapshotId${index},
        $sessionId${index},
        $turn${index},
        $turnId${index},
        $attempt${index},
        $manifestId${index},
        $eventIdsJson${index},
        $signalKindsJson${index},
        $manifestJson${index},
        $snapshotJson${index},
        cast($updatedAt${index} as double),
        $schemaVersion${index}
      )`;
    });
    await connection.run(
      `
        insert into session_harness_trace_snapshots (
          snapshot_id,
          session_id,
          turn,
          turn_id,
          attempt,
          manifest_id,
          event_ids_json,
          signal_kinds_json,
          manifest_json,
          snapshot_json,
          updated_at,
          schema_version
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}

function addStateEvent(state: HarnessProjectionState, record: BrewvaEventRecord): void {
  state.eventIds.add(record.id);
  state.updatedAt = Math.max(state.updatedAt, record.timestamp);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTurnEndedStatus(value: unknown): string | null {
  return value === "completed" || value === "failed" || value === "cancelled" ? value : null;
}

function readToolOutcomeVerdict(value: unknown): OutcomeVerdict | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "ok" && value.kind !== "err" && value.kind !== "inconclusive") return null;
  return outcomeVerdict(value as BrewvaOutcome);
}
