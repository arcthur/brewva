import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-runtime/protocol";
import type {
  DelegationAdoptionRecord,
  DelegationLifecycleEventPayload,
  DelegationRunQuery,
  DelegationRunRecord,
  PendingDelegationOutcomeQuery,
} from "@brewva/brewva-runtime/protocol";
import { isDelegationRunTerminalStatus } from "@brewva/brewva-runtime/protocol";
import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  readDelegationLifecycleEventPayload,
  readWorkerResultsAppliedEventPayload,
} from "@brewva/brewva-runtime/protocol";
import {
  projectSessionDelegationState,
  type SessionIndex,
  type SessionIndexDelegationRun,
} from "@brewva/brewva-session-index";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";
import { queryStructuredRuntimeEvents, subscribeRuntimeEvents } from "../hosted/api.js";
import { buildDelegationLifecyclePayload } from "./lifecycle-payload.js";
import { adoptDelegationLineageOutcome } from "./lineage.js";
import { recordDelegationRuntimeEvent } from "./runtime-events.js";
type IndexedDelegationStatus = DelegationRunRecord["status"];

const INDEXED_DELEGATION_STATUSES = new Set<IndexedDelegationStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "merged",
]);

function isIndexedDelegationStatus(value: string): value is IndexedDelegationStatus {
  return INDEXED_DELEGATION_STATUSES.has(value as IndexedDelegationStatus);
}

function eventTypeForIndexedDelegationStatus(status: IndexedDelegationStatus): string {
  if (status === "pending") return SUBAGENT_SPAWNED_EVENT_TYPE;
  if (status === "running") return SUBAGENT_RUNNING_EVENT_TYPE;
  if (status === "cancelled") return SUBAGENT_CANCELLED_EVENT_TYPE;
  if (status === "failed" || status === "timeout") return SUBAGENT_FAILED_EVENT_TYPE;
  return SUBAGENT_COMPLETED_EVENT_TYPE;
}

function delegationRunRecordFromIndexRow(
  row: SessionIndexDelegationRun,
): DelegationRunRecord | undefined {
  if (!isIndexedDelegationStatus(row.status)) {
    return undefined;
  }
  const payload = readDelegationLifecycleEventPayload({
    type: eventTypeForIndexedDelegationStatus(row.status),
    payload: row.record,
  });
  if (!payload?.runId) {
    return undefined;
  }
  const runId = payload.runId;
  const contractVersion = requireDelegationContractVersion(payload, runId);
  const identityFields = requireCurrentIdentityFields(payload, runId);
  const executionFields = requireExecutionContractFields(payload, runId);
  return {
    contractVersion,
    runId,
    ...identityFields,
    delegate: payload.delegate ?? identityFields.targetName,
    ...executionFields,
    adoption: requireDelegationAdoption(payload, runId),
    lineage: payload.lineage,
    agentSpec: payload.agentSpec,
    envelope: payload.envelope,
    skillName: payload.skillName,
    parentSessionId: asBrewvaSessionId(row.sessionId),
    status: payload.status ?? row.status,
    createdAt: typeof row.record.createdAt === "number" ? row.record.createdAt : row.updatedAt,
    updatedAt: row.updatedAt,
    label: payload.label,
    workerSessionId: payload.childSessionId,
    parentSkill: payload.parentSkill,
    kind: payload.kind,
    consultKind: payload.consultKind,
    boundary: payload.boundary,
    modelRoute: payload.modelRoute,
    summary: payload.summary,
    error: payload.error ?? payload.reason,
    resultData: payload.resultData,
    artifactRefs: payload.artifactRefs,
    delivery: payload.delivery,
    totalTokens: payload.totalTokens,
    costUsd: payload.costUsd,
  };
}

function requireDelegationContractVersion(
  payload: DelegationLifecycleEventPayload,
  runId: string,
): typeof CURRENT_DELEGATION_CONTRACT_VERSION {
  if (payload.contractVersion !== CURRENT_DELEGATION_CONTRACT_VERSION) {
    throw new Error(`unsupported_delegation_contract_version:${runId}`);
  }
  return CURRENT_DELEGATION_CONTRACT_VERSION;
}

function requireDelegationAdoption(
  payload: DelegationLifecycleEventPayload,
  runId: string,
): DelegationAdoptionRecord {
  if (payload.adoption) {
    return payload.adoption;
  }
  throw new Error(`invalid_delegation_contract:${runId}:missing_adoption`);
}

function requireCurrentIdentityFields(
  payload: DelegationLifecycleEventPayload,
  runId: string,
): Pick<
  DelegationRunRecord,
  | "agent"
  | "targetName"
  | "taskName"
  | "taskPath"
  | "nickname"
  | "depth"
  | "forkTurns"
  | "gateReason"
  | "modelCategory"
> {
  const agent = payload.agent;
  const targetName = payload.targetName;
  const taskName = payload.taskName;
  const taskPath = payload.taskPath;
  const nickname = payload.nickname;
  const depth = payload.depth;
  const forkTurns = payload.forkTurns;
  const gateReason = payload.gateReason;
  const modelCategory = payload.modelCategory;
  if (
    !agent ||
    !targetName ||
    !taskName ||
    !taskPath ||
    !nickname ||
    typeof depth !== "number" ||
    !forkTurns ||
    !gateReason ||
    !modelCategory
  ) {
    throw new Error(`invalid_delegation_contract:${runId}:missing_v3_identity`);
  }
  return {
    agent,
    targetName,
    taskName,
    taskPath,
    nickname,
    depth,
    forkTurns,
    gateReason,
    modelCategory,
  };
}

function requireExecutionContractFields(
  payload: DelegationLifecycleEventPayload,
  runId: string,
): Pick<DelegationRunRecord, "executionPrimitive" | "visibility" | "isolationStrategy"> {
  const executionPrimitive = payload.executionPrimitive;
  const visibility = payload.visibility;
  const isolationStrategy = payload.isolationStrategy;
  if (executionPrimitive && visibility && isolationStrategy) {
    return {
      executionPrimitive,
      visibility,
      isolationStrategy,
    };
  }
  throw new Error(`invalid_delegation_contract:${runId}:missing_execution_fields`);
}

export function cloneDelegationRunRecord(record: DelegationRunRecord): DelegationRunRecord {
  return structuredClone(record);
}

export { buildDelegationLifecyclePayload };

function adoptAppliedWorkerResultOutcomes(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  runs: Map<string, DelegationRunRecord>;
  event: { type: string; payload?: Record<string, unknown> };
}): void {
  if (input.event.type !== WORKER_RESULTS_APPLIED_EVENT_TYPE) {
    return;
  }
  const payload = readWorkerResultsAppliedEventPayload(input.event);
  for (const workerId of payload?.workerIds ?? []) {
    const record = input.runs.get(workerId);
    if (!record) {
      continue;
    }
    adoptDelegationLineageOutcome({
      runtime: input.runtime,
      sessionId: input.sessionId,
      record,
      admission: "context_required",
    });
  }
}

function filterDelegationRuns(
  runs: Iterable<DelegationRunRecord>,
  query: DelegationRunQuery = {},
): DelegationRunRecord[] {
  const runIdFilter =
    Array.isArray(query.runIds) && query.runIds.length > 0 ? new Set(query.runIds) : undefined;
  const taskPathFilter =
    Array.isArray(query.taskPaths) && query.taskPaths.length > 0
      ? new Set(query.taskPaths)
      : undefined;
  const nicknameFilter =
    Array.isArray(query.nicknames) && query.nicknames.length > 0
      ? new Set(query.nicknames)
      : undefined;
  const pathPrefix = typeof query.pathPrefix === "string" ? query.pathPrefix : undefined;
  const statusFilter =
    Array.isArray(query.statuses) && query.statuses.length > 0
      ? new Set(query.statuses)
      : undefined;
  const includeTerminal = query.includeTerminal !== false;
  const filtered = [...runs]
    .filter((record) => {
      if (runIdFilter && !runIdFilter.has(record.runId)) {
        return false;
      }
      if (taskPathFilter && !taskPathFilter.has(record.taskPath)) {
        return false;
      }
      if (nicknameFilter && !nicknameFilter.has(record.nickname)) {
        return false;
      }
      if (pathPrefix && !record.taskPath.startsWith(pathPrefix)) {
        return false;
      }
      if (!includeTerminal && isDelegationRunTerminalStatus(record.status)) {
        return false;
      }
      if (statusFilter && !statusFilter.has(record.status)) {
        return false;
      }
      return true;
    })
    .toSorted((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return left.runId.localeCompare(right.runId);
    })
    .map((record) => cloneDelegationRunRecord(record));
  if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
    return filtered.slice(0, Math.trunc(query.limit));
  }
  return filtered;
}

export class HostedDelegationStore {
  private unsubscribeWorkerResultAdoption: (() => void) | undefined;

  constructor(
    private readonly runtime: HostedRuntimeAdapterPort,
    options: {
      sessionIndex?: Promise<SessionIndex>;
    } = {},
  ) {
    this.sessionIndex = options.sessionIndex;
  }

  private readonly sessionIndex: Promise<SessionIndex> | undefined;

  dispose(): void {
    this.unsubscribeWorkerResultAdoption?.();
    this.unsubscribeWorkerResultAdoption = undefined;
  }

  clearSession(_sessionId: string): void {}

  installWorkerResultAdoptionSubscription(): void {
    if (this.unsubscribeWorkerResultAdoption) {
      return;
    }
    this.unsubscribeWorkerResultAdoption = subscribeRuntimeEvents(this.runtime, (event) => {
      if (event.type !== WORKER_RESULTS_APPLIED_EVENT_TYPE) {
        return;
      }
      adoptAppliedWorkerResultOutcomes({
        runtime: this.runtime,
        sessionId: event.sessionId,
        runs: this.rebuildRunsFromTape(event.sessionId),
        event,
      });
    });
  }

  getRun(sessionId: string, runId: string): DelegationRunRecord | undefined {
    const record = this.rebuildRunsFromTape(sessionId).get(runId);
    return record ? cloneDelegationRunRecord(record) : undefined;
  }

  listRuns(sessionId: string, query: DelegationRunQuery = {}): DelegationRunRecord[] {
    return filterDelegationRuns(this.rebuildRunsFromTape(sessionId).values(), query);
  }

  async listRunsFromReadModel(
    sessionId: string,
    query: DelegationRunQuery = {},
  ): Promise<DelegationRunRecord[]> {
    const indexed = await this.tryListIndexedRuns(sessionId, query);
    return indexed ?? this.listRuns(sessionId, query);
  }

  listPendingOutcomes(
    sessionId: string,
    query: PendingDelegationOutcomeQuery = {},
  ): DelegationRunRecord[] {
    const pending = [...this.rebuildRunsFromTape(sessionId).values()]
      .filter(
        (record) =>
          (record.status === "completed" ||
            record.status === "failed" ||
            record.status === "timeout" ||
            record.status === "cancelled") &&
          record.delivery?.handoffState === "pending_parent_turn",
      )
      .toSorted((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.runId.localeCompare(right.runId);
      })
      .map((record) => cloneDelegationRunRecord(record));
    if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
      return pending.slice(0, Math.trunc(query.limit));
    }
    return pending;
  }

  async listPendingOutcomesFromReadModel(
    sessionId: string,
    query: PendingDelegationOutcomeQuery = {},
  ): Promise<DelegationRunRecord[]> {
    const indexed = await this.tryListIndexedPendingOutcomes(sessionId, query);
    return indexed ?? this.listPendingOutcomes(sessionId, query);
  }

  markSurfaced(input: { sessionId: string; turn: number; runIds: readonly string[] }): void {
    if (input.runIds.length === 0) {
      return;
    }
    const surfacedAt = Date.now();
    for (const runId of input.runIds) {
      const existing = this.getRun(input.sessionId, runId);
      if (!existing?.delivery || existing.delivery.handoffState !== "pending_parent_turn") {
        continue;
      }
      const updated: DelegationRunRecord = {
        ...existing,
        updatedAt: surfacedAt,
        delivery: {
          ...existing.delivery,
          handoffState: "surfaced",
          surfacedAt,
          updatedAt: surfacedAt,
        },
      };
      recordDelegationRuntimeEvent({
        runtime: this.runtime,
        sessionId: input.sessionId,
        turn: input.turn,
        type: SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
        payload: buildDelegationLifecyclePayload(updated),
      });
    }
  }

  private rebuildRunsFromTape(sessionId: string): Map<string, DelegationRunRecord> {
    const runs = new Map<string, DelegationRunRecord>();
    const projection = projectSessionDelegationState({
      sessionId,
      records: queryStructuredRuntimeEvents(this.runtime, sessionId),
    });
    for (const row of projection.runs) {
      const record = delegationRunRecordFromIndexRow(row);
      if (record) {
        runs.set(record.runId, record);
      }
    }
    return runs;
  }

  private async tryListIndexedRuns(
    sessionId: string,
    query: DelegationRunQuery,
  ): Promise<DelegationRunRecord[] | undefined> {
    if (!this.sessionIndex) {
      return undefined;
    }
    try {
      const index = await this.sessionIndex;
      await index.catchUp();
      const rows = await index.listDelegationRuns({
        sessionId,
        includeTerminal: query.includeTerminal,
        limit: Math.max(query.limit ?? 100, 500),
      });
      const records = rows
        .map(delegationRunRecordFromIndexRow)
        .filter((record): record is DelegationRunRecord => Boolean(record));
      return filterDelegationRuns(records, query);
    } catch {
      return undefined;
    }
  }

  private async tryListIndexedPendingOutcomes(
    sessionId: string,
    query: PendingDelegationOutcomeQuery,
  ): Promise<DelegationRunRecord[] | undefined> {
    if (!this.sessionIndex) {
      return undefined;
    }
    try {
      const index = await this.sessionIndex;
      await index.catchUp();
      const rows = await index.listPendingDelegationOutcomes({
        sessionId,
        limit: Math.max(query.limit ?? 50, 50),
      });
      const records = rows
        .map(delegationRunRecordFromIndexRow)
        .filter((record): record is DelegationRunRecord => Boolean(record));
      return filterDelegationRuns(records, {
        statuses: ["completed", "failed", "timeout", "cancelled"],
        includeTerminal: true,
        limit: query.limit,
      });
    } catch {
      return undefined;
    }
  }
}
