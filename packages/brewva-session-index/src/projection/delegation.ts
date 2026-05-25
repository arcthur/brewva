import { chunkArray } from "@brewva/brewva-std/collections";
import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import { deriveParallelBudgetStateFromEvents } from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
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

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout", "cancelled", "merged"]);
const PENDING_OUTCOME_STATUSES = new Set(["completed", "failed", "timeout", "cancelled"]);

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
  "id" | "sessionId" | "type" | "timestamp" | "payload"
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

function withRunStatus(
  run: RunProjection,
  event: BrewvaEventRecord,
  status: string,
): RunProjection {
  const record = parsePayload(run.recordJson);
  return {
    ...run,
    status,
    recordJson: JSON.stringify({ ...record, status }),
    updatedAt: event.timestamp,
    eventId: event.id,
  };
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
    if (event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE) {
      const payload = payloadRecord(event);
      const workerIds = Array.isArray(payload.workerIds)
        ? payload.workerIds.map((id) => readString(id)).filter((id): id is string => Boolean(id))
        : [];
      for (const workerId of workerIds) {
        workerResults.delete(workerId);
        const run = runs.get(workerId);
        if (run) {
          runs.set(workerId, withRunStatus(run, event, "merged"));
        }
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
  const status =
    readString(payload.status) ??
    statusForDelegationEvent(event.type) ??
    existing?.status ??
    "pending";
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
    recordJson: JSON.stringify({ ...mergedRecord, status }),
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
