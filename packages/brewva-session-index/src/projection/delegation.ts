import { chunkArray } from "@brewva/brewva-std/collections";
import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
  WORKER_RESULTS_REJECTED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import { deriveParallelBudgetStateFromEvents } from "@brewva/brewva-vocabulary/delegation";
import type {
  DelegationAdoptionRequirement,
  DelegationInboxItem,
  DelegationInspectionProjection,
  DelegationIsolationStrategy,
  DelegationLifecycleReason,
  DelegationReplayTimeline,
  DelegationResultMode,
  DelegationRunCard,
  DelegationRunDisposition,
  DelegationRunStatus,
  DelegationTimelineGroupKind,
  PublicSubagentRole,
  RecoveryPreview,
  RecoveryPrimitive,
} from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
  SOURCE_PATCH_PREPARED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import type {
  SessionIndexDelegationProjection,
  SessionIndexDelegationRun,
  SessionIndexParallelBudgetView,
  SessionIndexWorkerResult,
} from "../api.js";
import { SESSION_INDEX_SCHEMA_VERSION } from "../api.js";
import type { DuckDBConnection } from "../duckdb/instance.js";
import { parsePayload, readString } from "../json.js";
import type { SessionIndexQueryPort } from "../query/port.js";
import { buildInList, type SqlParams } from "../sql/params.js";

const DELEGATION_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  SUBAGENT_SPAWNED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PENDING_OUTCOME_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_TRUST_TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "tool_call",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_phase_change",
  "tool_execution_end",
  "tool_call_ended",
  "tool_result",
]);
const ACTIVE_TRUST_APPROVAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "approval.requested",
  "approval.decided",
]);
const ACTIVE_TRUST_MUTATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
]);

interface DelegationRunRow {
  session_id: string;
  run_id: string;
  status: string;
  task_path: string | null;
  nickname: string | null;
  delegate: string | null;
  agent: string | null;
  kind: string | null;
  child_session_id: string | null;
  summary: string | null;
  error: string | null;
  delivery_handoff_state: string | null;
  record_json: string;
  updated_at: number;
  event_id: string;
  cursor_event_count: number;
  schema_version: number;
}

interface WorkerResultRow {
  session_id: string;
  worker_id: string;
  status: string;
  summary: string | null;
  patch_set_id: string | null;
  record_json: string;
  updated_at: number;
  event_id: string;
  cursor_event_count: number;
  schema_version: number;
}

interface ProjectionCursorRow {
  event_count: number;
  latest_event_id: string | null;
  schema_version: number;
}

type DelegationProjectionEvent = Pick<
  BrewvaEventRecord,
  "id" | "sessionId" | "turn" | "type" | "timestamp" | "payload"
>;

interface RunProjection {
  sessionId: string;
  runId: string;
  status: string;
  taskPath: string | null;
  nickname: string | null;
  delegate: string | null;
  agent: string | null;
  kind: string | null;
  childSessionId: string | null;
  summary: string | null;
  error: string | null;
  deliveryHandoffState: string | null;
  recordJson: string;
  updatedAt: number;
  eventId: string;
}

type WorkerProjection = NonNullable<ReturnType<typeof buildWorkerRecord>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function payloadRecord(event: DelegationProjectionEvent): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function patchSetId(payload: Record<string, unknown>): string | null {
  const direct = nullableString(payload.patchSetId);
  if (direct) return direct;
  if (isRecord(payload.patches)) {
    return nullableString(payload.patches.id);
  }
  return null;
}

function deliveryHandoffState(payload: Record<string, unknown>): string | null {
  if (isRecord(payload.delivery)) {
    return nullableString(payload.delivery.handoffState);
  }
  return nullableString(payload.deliveryHandoffState);
}

function statusForDelegationEvent(eventType: string): string | undefined {
  if (eventType === SUBAGENT_RUNNING_EVENT_TYPE) return "running";
  if (eventType === SUBAGENT_COMPLETED_EVENT_TYPE) return "completed";
  if (eventType === SUBAGENT_FAILED_EVENT_TYPE) return "failed";
  if (eventType === SUBAGENT_CANCELLED_EVENT_TYPE) return "cancelled";
  if (eventType === SUBAGENT_SPAWNED_EVENT_TYPE) return "pending";
  return undefined;
}

function lifecycleReasonOf(payload: Record<string, unknown>): DelegationLifecycleReason {
  const explicit = readString(payload.lifecycleReason) ?? readString(payload.reason);
  if (
    explicit === "timeout" ||
    explicit === "user" ||
    explicit === "policy" ||
    explicit === "crash" ||
    explicit === "missing_evidence" ||
    explicit === "approval_wait"
  ) {
    return explicit;
  }
  if (readString(payload.status) === "timeout") {
    return "timeout";
  }
  return "none";
}

function normalizeLifecycleStatus(input: {
  readonly payload: Record<string, unknown>;
  readonly eventType: string;
  readonly existingStatus?: string;
}): DelegationRunStatus {
  const rawStatus = readString(input.payload.status);
  if (rawStatus === "pending" || rawStatus === "running" || rawStatus === "blocked") {
    return rawStatus;
  }
  if (rawStatus === "completed" || rawStatus === "failed" || rawStatus === "cancelled") {
    return rawStatus;
  }
  if (rawStatus === "timeout") {
    return "failed";
  }
  if (rawStatus === "merged") {
    return input.existingStatus === "pending" || input.existingStatus === "running"
      ? "completed"
      : (normalizeExistingLifecycleStatus(input.existingStatus) ?? "completed");
  }
  const eventStatus = statusForDelegationEvent(input.eventType);
  return normalizeExistingLifecycleStatus(eventStatus) ?? "pending";
}

function normalizeExistingLifecycleStatus(
  status: string | undefined,
): DelegationRunStatus | undefined {
  if (
    status === "pending" ||
    status === "running" ||
    status === "blocked" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return undefined;
}

function buildWorkerRecord(payload: Record<string, unknown>, event: DelegationProjectionEvent) {
  const workerId = readString(payload.runId) ?? readString(payload.workerId);
  if (!workerId) return undefined;
  const patchSet = patchSetId(payload);
  if (readString(payload.kind) !== "patch" && !patchSet) return undefined;
  const status =
    event.type === SUBAGENT_COMPLETED_EVENT_TYPE ? (patchSet ? "ok" : "skipped") : "error";
  return {
    sessionId: event.sessionId,
    workerId,
    status,
    summary: nullableString(payload.summary),
    patchSetId: patchSet,
    recordJson: JSON.stringify(payload),
    updatedAt: event.timestamp,
    eventId: event.id,
  };
}

export async function rebuildSessionDelegationProjection(input: {
  connection: DuckDBConnection;
  sessionId: string;
  records: readonly BrewvaEventRecord[];
}): Promise<void> {
  await input.connection.run("delete from session_delegation_runs where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  await input.connection.run("delete from session_worker_results where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  await input.connection.run(
    "delete from session_projection_cursors where session_id = $sessionId and projection in ('delegation_runs', 'parallel_budget')",
    { sessionId: input.sessionId },
  );

  const projected = projectDelegationRows(input.records);

  await insertDelegationRuns(input.connection, projected.runs, projected.eventCount);
  await insertWorkerResults(input.connection, projected.workerResults, projected.eventCount);
  await insertProjectionCursor(input.connection, {
    sessionId: input.sessionId,
    projection: "delegation_runs",
    eventCount: projected.eventCount,
    latestEventId: projected.latestEventId,
  });
  await insertProjectionCursor(input.connection, {
    sessionId: input.sessionId,
    projection: "parallel_budget",
    eventCount: projected.eventCount,
    latestEventId: projected.latestEventId,
  });
}

function projectDelegationRows(records: readonly DelegationProjectionEvent[]): {
  runs: RunProjection[];
  workerResults: WorkerProjection[];
  eventCount: number;
  latestEventId?: string;
} {
  const runs = new Map<string, RunProjection>();
  const workerResults = new Map<string, WorkerProjection>();
  let latestEventId: string | undefined;

  for (const event of records) {
    latestEventId = event.id;
    if (
      event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE ||
      event.type === WORKER_RESULTS_REJECTED_EVENT_TYPE
    ) {
      const payload = payloadRecord(event);
      const workerIds = Array.isArray(payload.workerIds)
        ? payload.workerIds.map((id) => readString(id)).filter((id): id is string => Boolean(id))
        : [];
      for (const workerId of workerIds) {
        workerResults.delete(workerId);
      }
      continue;
    }
    if (!DELEGATION_LIFECYCLE_EVENTS.has(event.type)) continue;
    const payload = payloadRecord(event);
    const runId = readString(payload.runId);
    const run = buildRunProjection(payload, event, runId ? runs.get(runId) : undefined);
    if (!run) continue;
    runs.set(run.runId, run);
    if (
      event.type === SUBAGENT_COMPLETED_EVENT_TYPE ||
      event.type === SUBAGENT_FAILED_EVENT_TYPE ||
      event.type === SUBAGENT_CANCELLED_EVENT_TYPE
    ) {
      const worker = buildWorkerRecord(payload, event);
      if (worker) workerResults.set(worker.workerId, worker);
    }
  }

  return {
    runs: [...runs.values()],
    workerResults: [...workerResults.values()],
    eventCount: records.length,
    latestEventId,
  };
}

export function projectSessionDelegationState(input: {
  sessionId: string;
  records: readonly DelegationProjectionEvent[];
}): SessionIndexDelegationProjection {
  const projected = projectDelegationRows(input.records);
  const parallelBudget = deriveParallelBudgetStateFromEvents(input.records);
  const runs = projected.runs.map((row) => mapRunProjection(row, projected.eventCount));
  const workerResults = projected.workerResults.map((row) =>
    mapWorkerProjection(row, projected.eventCount),
  );
  return {
    sessionId: input.sessionId,
    runs,
    workerResults,
    parallelBudget: {
      sessionId: input.sessionId,
      activeRunIds: parallelBudget.activeRunIds.toSorted(),
      totalStarted: parallelBudget.totalStarted,
      eventCount: projected.eventCount,
      ...(parallelBudget.latestEventId ? { latestEventId: parallelBudget.latestEventId } : {}),
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    },
  };
}

export function projectDelegationInspectionState(input: {
  sessionId: string;
  records: readonly DelegationProjectionEvent[];
}): DelegationInspectionProjection {
  const records = input.records.filter((event) => event.sessionId === input.sessionId);
  const replay = projectSessionDelegationState({ sessionId: input.sessionId, records });
  const dispositionState = buildDispositionState(records);
  const runCards = markSupersededVerifierCards(
    replay.runs.map((run) => buildRunCard(run, dispositionState)),
  ).toSorted((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.runId.localeCompare(right.runId);
  });
  return {
    sessionId: input.sessionId,
    runCards,
    workboard: buildWorkboard(runCards),
    inbox: buildInbox(runCards),
    timeline: buildTimeline(records),
    recoveryPreview: buildRecoveryPreview(input.sessionId, records, runCards),
  };
}

function markSupersededVerifierCards(
  cards: readonly DelegationRunCard[],
): readonly DelegationRunCard[] {
  const latestVerifierByPath = new Map<string, DelegationRunCard>();
  for (const card of cards) {
    if (card.resultMode !== "verifier" || !card.taskPath) {
      continue;
    }
    const latest = latestVerifierByPath.get(card.taskPath);
    if (!latest || card.updatedAt > latest.updatedAt) {
      latestVerifierByPath.set(card.taskPath, card);
    }
  }
  return cards.map((card) => {
    if (card.resultMode !== "verifier" || !card.taskPath || card.disposition !== "unread") {
      return card;
    }
    const latest = latestVerifierByPath.get(card.taskPath);
    return latest && latest.runId !== card.runId
      ? { ...card, disposition: "superseded" as const }
      : card;
  });
}

interface DispositionState {
  readonly preparedWorkerIds: ReadonlySet<string>;
  readonly appliedWorkerIds: ReadonlySet<string>;
  readonly applyFailedWorkerIds: ReadonlySet<string>;
  readonly rejectedWorkerIds: ReadonlySet<string>;
  readonly knowledgeDecisions: ReadonlyMap<string, string>;
  readonly latestMutationAt: number;
}

function buildDispositionState(records: readonly DelegationProjectionEvent[]): DispositionState {
  const preparedWorkerIds = new Set<string>();
  const appliedWorkerIds = new Set<string>();
  const applyFailedWorkerIds = new Set<string>();
  const rejectedWorkerIds = new Set<string>();
  const knowledgeDecisions = new Map<string, string>();
  let latestMutationAt = 0;

  for (const event of records) {
    const payload = payloadRecord(event);
    if (event.type === SOURCE_PATCH_PREPARED_EVENT_TYPE) {
      for (const workerId of workerIdsFromSourcePatchPlan(payload)) {
        preparedWorkerIds.add(workerId);
      }
      continue;
    }
    if (event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE) {
      for (const workerId of workerIdsFromPayload(payload)) {
        appliedWorkerIds.add(workerId);
      }
      latestMutationAt = Math.max(latestMutationAt, event.timestamp);
      continue;
    }
    if (
      event.type === WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE ||
      event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE
    ) {
      const failed = event.type === WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE || payload.ok === false;
      if (failed) {
        for (const workerId of workerIdsFromPayload(payload)) {
          applyFailedWorkerIds.add(workerId);
        }
      }
      if (payload.ok !== false) {
        latestMutationAt = Math.max(latestMutationAt, event.timestamp);
      }
      continue;
    }
    if (event.type === WORKER_RESULTS_REJECTED_EVENT_TYPE) {
      for (const workerId of workerIdsFromPayload(payload)) {
        rejectedWorkerIds.add(workerId);
      }
      continue;
    }
    if (event.type === SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE) {
      const runId = readString(payload.runId);
      const decision = readString(payload.decision);
      if (runId && decision) {
        knowledgeDecisions.set(runId, decision);
      }
    }
  }

  return {
    preparedWorkerIds,
    appliedWorkerIds,
    applyFailedWorkerIds,
    rejectedWorkerIds,
    knowledgeDecisions,
    latestMutationAt,
  };
}

function workerIdsFromSourcePatchPlan(payload: Record<string, unknown>): string[] {
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  return metadata ? workerIdsFromPayload(metadata) : [];
}

function workerIdsFromPayload(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.workerIds)) {
    return [];
  }
  return payload.workerIds.map((id) => readString(id)).filter((id): id is string => Boolean(id));
}

function buildRunCard(
  run: SessionIndexDelegationRun,
  dispositionState: DispositionState,
): DelegationRunCard {
  const record = run.record;
  const role = roleOf(record.agent ?? run.agent);
  const resultMode = resultModeOf(record.kind ?? run.kind, role);
  const lifecycle = normalizeExistingLifecycleStatus(run.status) ?? "failed";
  const lifecycleReason = lifecycleReasonOf(record);
  const title =
    readString(record.label) ??
    readString(record.nickname) ??
    readString(record.taskName) ??
    run.nickname ??
    run.runId;
  return {
    runId: run.runId,
    role,
    resultMode,
    lifecycle,
    lifecycleReason,
    retention: readString(record.retention) === "archived" ? "archived" : "live",
    disposition: dispositionOf({
      run,
      role,
      resultMode,
      lifecycle,
      dispositionState,
    }),
    adoptionRequirement: adoptionRequirementFor(resultMode),
    title,
    ...(run.taskPath ? { taskPath: run.taskPath } : {}),
    ...(run.summary ? { summary: run.summary } : {}),
    ...(run.error ? { error: run.error } : {}),
    isolation: isolationOf(record.isolationStrategy),
    createdAt: typeof record.createdAt === "number" ? record.createdAt : run.updatedAt,
    updatedAt: run.updatedAt,
    eventId: run.eventId,
    canonicalRefs: [`event:${run.eventId}`, `delegation:${run.runId}`],
  };
}

function roleOf(value: unknown): PublicSubagentRole {
  if (
    value === "navigator" ||
    value === "explorer" ||
    value === "worker" ||
    value === "verifier" ||
    value === "librarian"
  ) {
    return value;
  }
  return "explorer";
}

function resultModeOf(value: unknown, role: PublicSubagentRole): DelegationResultMode {
  if (
    value === "evidence" ||
    value === "consult" ||
    value === "patch" ||
    value === "verifier" ||
    value === "knowledge"
  ) {
    return value;
  }
  if (role === "navigator") return "evidence";
  if (role === "worker") return "patch";
  if (role === "verifier") return "verifier";
  if (role === "librarian") return "knowledge";
  return "consult";
}

function adoptionRequirementFor(resultMode: DelegationResultMode): DelegationAdoptionRequirement {
  if (resultMode === "patch") return "patch_apply";
  if (resultMode === "knowledge") return "knowledge_adopt";
  return "none";
}

function isolationOf(value: unknown): DelegationIsolationStrategy {
  if (
    value === "shared" ||
    value === "snapshot" ||
    value === "worktree" ||
    value === "ephemeral_exec" ||
    value === "a2a_channel"
  ) {
    return value;
  }
  return "shared";
}

function dispositionOf(input: {
  readonly run: SessionIndexDelegationRun;
  readonly role: PublicSubagentRole;
  readonly resultMode: DelegationResultMode;
  readonly lifecycle: DelegationRunStatus;
  readonly dispositionState: DispositionState;
}): DelegationRunDisposition {
  if (input.resultMode === "patch" || input.role === "worker") {
    if (input.dispositionState.appliedWorkerIds.has(input.run.runId)) return "applied";
    if (input.dispositionState.applyFailedWorkerIds.has(input.run.runId)) return "apply_failed";
    if (input.dispositionState.rejectedWorkerIds.has(input.run.runId)) return "rejected";
    if (input.dispositionState.preparedWorkerIds.has(input.run.runId)) return "prepared";
    return "pending_apply";
  }
  if (input.resultMode === "knowledge" || input.role === "librarian") {
    const decision = input.dispositionState.knowledgeDecisions.get(input.run.runId);
    if (decision === "accept") return "adopted";
    if (decision === "reject") return "rejected";
    if (decision === "defer") return "deferred";
    return "pending_knowledge_adopt";
  }
  if (input.resultMode === "verifier" || input.role === "verifier") {
    if (
      input.lifecycle === "completed" &&
      input.dispositionState.latestMutationAt > input.run.updatedAt
    ) {
      return "stale";
    }
    return "unread";
  }
  const delivery = isRecord(input.run.record.delivery) ? input.run.record.delivery : {};
  return readString(delivery.handoffState) === "surfaced" ? "consumed" : "unread";
}

function buildWorkboard(runCards: readonly DelegationRunCard[]) {
  return {
    pendingWorkerPatches: runCards.filter(isActionableWorkerPatch),
    pendingKnowledgeAdoptions: runCards.filter(
      (card) =>
        card.adoptionRequirement === "knowledge_adopt" &&
        card.disposition === "pending_knowledge_adopt",
    ),
    unreadEvidence: runCards.filter(
      (card) =>
        (card.resultMode === "evidence" ||
          card.resultMode === "consult" ||
          card.resultMode === "verifier") &&
        card.disposition === "unread",
    ),
    verificationDebt: runCards.filter(
      (card) =>
        card.resultMode === "verifier" &&
        (card.disposition === "stale" ||
          card.disposition === "superseded" ||
          card.lifecycle === "failed" ||
          card.lifecycleReason === "missing_evidence"),
    ),
    blockedOrFailedRuns: runCards.filter(
      (card) => card.lifecycle === "blocked" || card.lifecycle === "failed",
    ),
  };
}

function buildInbox(runCards: readonly DelegationRunCard[]) {
  const items: DelegationInboxItem[] = [];
  for (const card of runCards) {
    if (isActionableWorkerPatch(card)) {
      items.push(inboxItem(card, "worker_patch"));
      continue;
    }
    if (
      card.adoptionRequirement === "knowledge_adopt" &&
      card.disposition === "pending_knowledge_adopt"
    ) {
      items.push(inboxItem(card, "librarian_knowledge"));
      continue;
    }
    if (
      card.resultMode === "verifier" &&
      (card.disposition === "stale" || card.disposition === "superseded")
    ) {
      items.push(inboxItem(card, "verification_debt"));
      continue;
    }
    if (card.lifecycle === "failed" || card.lifecycle === "blocked") {
      items.push(inboxItem(card, "failed_run"));
      continue;
    }
    if (
      (card.resultMode === "evidence" ||
        card.resultMode === "consult" ||
        card.resultMode === "verifier") &&
      card.disposition === "unread"
    ) {
      items.push(inboxItem(card, "delegation_evidence"));
    }
  }
  return { items, explicitPull: true as const };
}

function inboxItem(
  card: DelegationRunCard,
  kind: DelegationInboxItem["kind"],
): DelegationInboxItem {
  return {
    itemId: `${kind}:${card.runId}`,
    kind,
    runId: card.runId,
    title: card.title,
    ...(card.summary ? { summary: card.summary } : {}),
    disposition: card.disposition,
    adoptionRequirement: card.adoptionRequirement,
    eventId: card.eventId,
    canonicalRefs: card.canonicalRefs,
  };
}

function isActionableWorkerPatch(card: DelegationRunCard): boolean {
  return (
    card.adoptionRequirement === "patch_apply" &&
    card.lifecycle === "completed" &&
    (card.disposition === "pending_apply" ||
      card.disposition === "prepared" ||
      card.disposition === "apply_failed")
  );
}

function buildTimeline(records: readonly DelegationProjectionEvent[]): DelegationReplayTimeline {
  const groups = new Map<
    string,
    {
      groupId: string;
      kind: DelegationTimelineGroupKind;
      timestamp: number;
      turn?: number;
      titles: Set<string>;
      summaries: string[];
      eventIds: string[];
      canonicalRefs: Set<string>;
    }
  >();
  for (const event of records) {
    const payload = payloadRecord(event);
    const kind = timelineKind(event, payload);
    const key = typeof event.turn === "number" ? `turn:${event.turn}:${kind}` : `event:${event.id}`;
    const group = groups.get(key);
    const title = timelineTitle(event, payload, kind);
    const refs = timelineCanonicalRefs(event, payload);
    if (group) {
      group.timestamp = Math.min(group.timestamp, event.timestamp);
      group.titles.add(title);
      group.summaries.push(timelineSummary(event, payload, kind));
      group.eventIds.push(event.id);
      for (const ref of refs) {
        group.canonicalRefs.add(ref);
      }
      continue;
    }
    groups.set(key, {
      groupId: `timeline:${event.id}`,
      kind,
      timestamp: event.timestamp,
      ...(typeof event.turn === "number" ? { turn: event.turn } : {}),
      titles: new Set([title]),
      summaries: [timelineSummary(event, payload, kind)],
      eventIds: [event.id],
      canonicalRefs: new Set(refs),
    });
  }
  return {
    explicitPull: true,
    groups: [...groups.values()].map((group) => {
      const projected = {
        groupId: group.groupId,
        kind: group.kind,
        timestamp: group.timestamp,
        title:
          group.titles.size === 1
            ? [...group.titles][0]!
            : `${group.kind}:turn:${group.turn ?? "unknown"}`,
        summary: group.summaries.join(" | "),
        eventIds: group.eventIds,
        canonicalRefs: [...group.canonicalRefs],
      };
      return typeof group.turn === "number"
        ? Object.assign(projected, { turn: group.turn })
        : projected;
    }),
  };
}

function timelineCanonicalRefs(
  event: DelegationProjectionEvent,
  payload: Record<string, unknown>,
): string[] {
  const runId = readString(payload.runId);
  return runId ? [`event:${event.id}`, `delegation:${runId}`] : [`event:${event.id}`];
}

function timelineKind(
  event: DelegationProjectionEvent,
  payload: Record<string, unknown>,
): DelegationTimelineGroupKind {
  if (DELEGATION_LIFECYCLE_EVENTS.has(event.type)) {
    return readString(payload.kind) === "verifier" || readString(payload.agent) === "verifier"
      ? "verification"
      : "delegation";
  }
  if (
    event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE ||
    event.type === WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE ||
    event.type === SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE ||
    event.type === SOURCE_PATCH_PREPARED_EVENT_TYPE ||
    event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE
  ) {
    return "adoption";
  }
  if (event.type.startsWith("tool_")) {
    return "tool";
  }
  if (event.type.includes("rewind") || event.type.includes("rollback")) {
    return "recovery";
  }
  if (event.type.startsWith("turn_") || event.type === "message.end") {
    return "turn";
  }
  return "other";
}

function timelineTitle(
  event: DelegationProjectionEvent,
  payload: Record<string, unknown>,
  kind: DelegationTimelineGroupKind,
): string {
  if (kind === "tool") {
    return `tool:${readString(payload.toolName) ?? "unknown"}`;
  }
  const runId = readString(payload.runId);
  if (runId) {
    return `${kind}:${runId}`;
  }
  return event.type;
}

function timelineSummary(
  event: DelegationProjectionEvent,
  payload: Record<string, unknown>,
  kind: DelegationTimelineGroupKind,
): string {
  if (kind === "tool") {
    return `tool event ${event.type} redacted`;
  }
  const summary =
    readString(payload.summary) ?? readString(payload.error) ?? readString(payload.reason);
  return summary ? redactSummary(summary) : `event ${event.type}`;
}

function redactSummary(value: string): string {
  return value
    .replace(/SECRET[_A-Z0-9]*=\S+/gu, "[REDACTED_SECRET]")
    .replace(/printenv\s+SECRET[_A-Z0-9]*/giu, "[REDACTED_COMMAND]");
}

function buildRecoveryPreview(
  sessionId: string,
  records: readonly DelegationProjectionEvent[],
  runCards: readonly DelegationRunCard[],
): RecoveryPreview {
  const primitives: RecoveryPrimitive[] = [
    { kind: "resume" },
    { kind: "session_rewind", scope: "both" },
  ];
  if (records.some((event) => event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE)) {
    primitives.push({ kind: "rollback_last_patch" });
  }
  for (const card of runCards) {
    if (isActionableWorkerPatch(card)) {
      primitives.push({
        kind: "reject_adoption",
        target: "worker_patch",
        runId: card.runId,
      });
    }
    if (
      card.adoptionRequirement === "knowledge_adopt" &&
      card.disposition === "pending_knowledge_adopt"
    ) {
      primitives.push({
        kind: "reject_adoption",
        target: "librarian_knowledge",
        runId: card.runId,
      });
    }
  }
  return {
    continuationAnchor: records.at(-1)
      ? { kind: "event", id: records.at(-1)!.id }
      : { kind: "baseline", id: `session:${sessionId}` },
    activeTrust: {
      toolCalls: records.filter((event) => ACTIVE_TRUST_TOOL_EVENT_TYPES.has(event.type)).length,
      approvals: records.filter((event) => ACTIVE_TRUST_APPROVAL_EVENT_TYPES.has(event.type))
        .length,
      mutations: records.filter((event) => ACTIVE_TRUST_MUTATION_EVENT_TYPES.has(event.type))
        .length,
      workerResults: runCards.filter((card) => card.adoptionRequirement === "patch_apply").length,
      verifierEvidence: runCards.filter((card) => card.resultMode === "verifier").length,
    },
    primitives: dedupeRecoveryPrimitives(primitives),
    nextReceiptOwner: "parent",
  };
}

function dedupeRecoveryPrimitives(primitives: readonly RecoveryPrimitive[]): RecoveryPrimitive[] {
  const seen = new Set<string>();
  const result: RecoveryPrimitive[] = [];
  for (const primitive of primitives) {
    const key = JSON.stringify(primitive);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(primitive);
  }
  return result;
}

function buildRunProjection(
  payload: Record<string, unknown>,
  event: DelegationProjectionEvent,
  existing?: RunProjection,
) {
  const runId = readString(payload.runId);
  if (!runId) return undefined;
  const previousRecord = existing ? parsePayload(existing.recordJson) : {};
  const mergedRecord: Record<string, unknown> = {
    ...previousRecord,
    ...payload,
    createdAt:
      typeof previousRecord.createdAt === "number" ? previousRecord.createdAt : event.timestamp,
  };
  const status = normalizeLifecycleStatus({
    payload,
    eventType: event.type,
    existingStatus: existing?.status,
  });
  const lifecycleReason = lifecycleReasonOf(payload);
  return {
    sessionId: event.sessionId,
    runId,
    status,
    taskPath: nullableString(mergedRecord.taskPath),
    nickname: nullableString(mergedRecord.nickname),
    delegate: nullableString(mergedRecord.delegate),
    agent: nullableString(mergedRecord.agent),
    kind: nullableString(mergedRecord.kind),
    childSessionId: nullableString(mergedRecord.childSessionId),
    summary: nullableString(mergedRecord.summary),
    error: nullableString(mergedRecord.error),
    deliveryHandoffState: deliveryHandoffState(mergedRecord),
    recordJson: JSON.stringify({
      ...mergedRecord,
      status,
      lifecycleReason,
      retention: readString(mergedRecord.retention) ?? "live",
    }),
    updatedAt: event.timestamp,
    eventId: event.id,
  };
}

async function insertDelegationRuns(
  connection: DuckDBConnection,
  rows: readonly RunProjection[],
  cursorEventCount: number,
): Promise<void> {
  for (const chunk of chunkArray(rows, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`sessionId${index}`] = row.sessionId;
      params[`runId${index}`] = row.runId;
      params[`status${index}`] = row.status;
      params[`taskPath${index}`] = row.taskPath;
      params[`nickname${index}`] = row.nickname;
      params[`delegate${index}`] = row.delegate;
      params[`agent${index}`] = row.agent;
      params[`kind${index}`] = row.kind;
      params[`childSessionId${index}`] = row.childSessionId;
      params[`summary${index}`] = row.summary;
      params[`error${index}`] = row.error;
      params[`deliveryHandoffState${index}`] = row.deliveryHandoffState;
      params[`recordJson${index}`] = row.recordJson;
      params[`updatedAt${index}`] = String(row.updatedAt);
      params[`eventId${index}`] = row.eventId;
      params[`cursorEventCount${index}`] = cursorEventCount;
      params[`schemaVersion${index}`] = SESSION_INDEX_SCHEMA_VERSION;
      return `($sessionId${index}, $runId${index}, $status${index}, $taskPath${index}, $nickname${index}, $delegate${index}, $agent${index}, $kind${index}, $childSessionId${index}, $summary${index}, $error${index}, $deliveryHandoffState${index}, $recordJson${index}, cast($updatedAt${index} as double), $eventId${index}, $cursorEventCount${index}, $schemaVersion${index})`;
    });
    await connection.run(
      `
        insert into session_delegation_runs (
          session_id, run_id, status, task_path, nickname, delegate, agent, kind,
          child_session_id, summary, error, delivery_handoff_state, record_json,
          updated_at, event_id, cursor_event_count, schema_version
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertWorkerResults(
  connection: DuckDBConnection,
  rows: readonly WorkerProjection[],
  cursorEventCount: number,
): Promise<void> {
  for (const chunk of chunkArray(rows, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`sessionId${index}`] = row.sessionId;
      params[`workerId${index}`] = row.workerId;
      params[`status${index}`] = row.status;
      params[`summary${index}`] = row.summary;
      params[`patchSetId${index}`] = row.patchSetId;
      params[`recordJson${index}`] = row.recordJson;
      params[`updatedAt${index}`] = String(row.updatedAt);
      params[`eventId${index}`] = row.eventId;
      params[`cursorEventCount${index}`] = cursorEventCount;
      params[`schemaVersion${index}`] = SESSION_INDEX_SCHEMA_VERSION;
      return `($sessionId${index}, $workerId${index}, $status${index}, $summary${index}, $patchSetId${index}, $recordJson${index}, cast($updatedAt${index} as double), $eventId${index}, $cursorEventCount${index}, $schemaVersion${index})`;
    });
    await connection.run(
      `
        insert into session_worker_results (
          session_id, worker_id, status, summary, patch_set_id, record_json,
          updated_at, event_id, cursor_event_count, schema_version
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertProjectionCursor(
  connection: DuckDBConnection,
  input: {
    sessionId: string;
    projection: string;
    eventCount: number;
    latestEventId?: string;
  },
): Promise<void> {
  await connection.run(
    `
      insert into session_projection_cursors (
        session_id, projection, event_count, latest_event_id, schema_version, updated_at
      ) values (
        $sessionId, $projection, $eventCount, $latestEventId, $schemaVersion, cast($updatedAt as double)
      )
    `,
    {
      sessionId: input.sessionId,
      projection: input.projection,
      eventCount: input.eventCount,
      latestEventId: input.latestEventId ?? null,
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      updatedAt: String(Date.now()),
    },
  );
}

export async function listDelegationRunRows(input: {
  port: SessionIndexQueryPort;
  sessionId?: string;
  includeTerminal?: boolean;
  limit?: number;
}): Promise<SessionIndexDelegationRun[]> {
  await input.port.ensureAvailable();
  const params: SqlParams = {};
  const filters: string[] = [];
  if (input.sessionId) {
    params.sessionId = input.sessionId;
    filters.push("session_id = $sessionId");
  }
  if (input.includeTerminal !== true) {
    const terminalFilter = buildInList("terminal", [...TERMINAL_STATUSES], params);
    filters.push(`status not in (${terminalFilter})`);
  }
  const limit = Math.max(1, Math.trunc(input.limit ?? 100));
  params.limit = limit;
  const where = filters.length > 0 ? `where ${filters.join(" and ")}` : "";
  const rows = await input.port.selectRows<DelegationRunRow>(
    `
      select * from session_delegation_runs
      ${where}
      order by updated_at desc
      limit $limit
    `,
    params,
  );
  return rows.map(mapDelegationRunRow);
}

export async function listPendingDelegationOutcomeRows(input: {
  port: SessionIndexQueryPort;
  sessionId: string;
  limit?: number;
}): Promise<SessionIndexDelegationRun[]> {
  await input.port.ensureAvailable();
  const params: SqlParams = {
    sessionId: input.sessionId,
    limit: Math.max(1, Math.trunc(input.limit ?? 50)),
  };
  const pendingStatusFilter = buildInList("pendingStatus", [...PENDING_OUTCOME_STATUSES], params);
  const rows = await input.port.selectRows<DelegationRunRow>(
    `
      select *
      from session_delegation_runs
      where session_id = $sessionId
        and status in (${pendingStatusFilter})
        and delivery_handoff_state = 'pending_parent_turn'
      order by updated_at desc
      limit $limit
    `,
    params,
  );
  return rows.map(mapDelegationRunRow);
}

export async function listWorkerResultRows(input: {
  port: SessionIndexQueryPort;
  sessionId?: string;
  limit?: number;
}): Promise<SessionIndexWorkerResult[]> {
  await input.port.ensureAvailable();
  const params: SqlParams = { limit: Math.max(1, Math.trunc(input.limit ?? 100)) };
  const where = input.sessionId ? "where session_id = $sessionId" : "";
  if (input.sessionId) params.sessionId = input.sessionId;
  const rows = await input.port.selectRows<WorkerResultRow>(
    `
      select * from session_worker_results
      ${where}
      order by updated_at desc
      limit $limit
    `,
    params,
  );
  return rows.map(mapWorkerResultRow);
}

export async function getParallelBudgetViewRow(input: {
  port: SessionIndexQueryPort;
  sessionId: string;
}): Promise<SessionIndexParallelBudgetView> {
  await input.port.ensureAvailable();
  const params: SqlParams = { sessionId: input.sessionId };
  const terminalFilter = buildInList("terminal", [...TERMINAL_STATUSES], params);
  const slots = await input.port.selectRows<{ run_id: string }>(
    `
      select run_id
      from session_delegation_runs
      where session_id = $sessionId and status not in (${terminalFilter})
      order by run_id
    `,
    params,
  );
  const cursor = await input.port.selectOne<ProjectionCursorRow>(
    "select event_count, latest_event_id, schema_version from session_projection_cursors where session_id = $sessionId and projection = 'parallel_budget'",
    { sessionId: input.sessionId },
  );
  const started = await input.port.selectOne<{ total_started: bigint | number }>(
    "select count(*) as total_started from session_delegation_runs where session_id = $sessionId",
    { sessionId: input.sessionId },
  );
  return {
    sessionId: input.sessionId,
    activeRunIds: slots.map((slot) => slot.run_id),
    totalStarted: Number(started?.total_started ?? 0),
    eventCount: cursor?.event_count ?? 0,
    ...(cursor?.latest_event_id ? { latestEventId: cursor.latest_event_id } : {}),
    schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
  };
}

function mapDelegationRunRow(row: DelegationRunRow): SessionIndexDelegationRun {
  return {
    sessionId: row.session_id,
    runId: row.run_id,
    status: row.status,
    ...(row.task_path ? { taskPath: row.task_path } : {}),
    ...(row.nickname ? { nickname: row.nickname } : {}),
    ...(row.delegate ? { delegate: row.delegate } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.child_session_id ? { childSessionId: row.child_session_id } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.error ? { error: row.error } : {}),
    updatedAt: row.updated_at,
    eventId: row.event_id,
    record: parsePayload(row.record_json),
    cursor: {
      eventCount: row.cursor_event_count,
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    },
  };
}

function mapWorkerResultRow(row: WorkerResultRow): SessionIndexWorkerResult {
  return {
    sessionId: row.session_id,
    workerId: row.worker_id,
    status: row.status,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.patch_set_id ? { patchSetId: row.patch_set_id } : {}),
    updatedAt: row.updated_at,
    eventId: row.event_id,
    record: parsePayload(row.record_json),
    cursor: {
      eventCount: row.cursor_event_count,
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    },
  };
}

function mapRunProjection(row: RunProjection, cursorEventCount: number): SessionIndexDelegationRun {
  return {
    sessionId: row.sessionId,
    runId: row.runId,
    status: row.status,
    ...(row.taskPath ? { taskPath: row.taskPath } : {}),
    ...(row.nickname ? { nickname: row.nickname } : {}),
    ...(row.delegate ? { delegate: row.delegate } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.childSessionId ? { childSessionId: row.childSessionId } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.error ? { error: row.error } : {}),
    updatedAt: row.updatedAt,
    eventId: row.eventId,
    record: parsePayload(row.recordJson),
    cursor: {
      eventCount: cursorEventCount,
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    },
  };
}

function mapWorkerProjection(
  row: WorkerProjection,
  cursorEventCount: number,
): SessionIndexWorkerResult {
  return {
    sessionId: row.sessionId,
    workerId: row.workerId,
    status: row.status,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.patchSetId ? { patchSetId: row.patchSetId } : {}),
    updatedAt: row.updatedAt,
    eventId: row.eventId,
    record: parsePayload(row.recordJson),
    cursor: {
      eventCount: cursorEventCount,
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    },
  };
}
