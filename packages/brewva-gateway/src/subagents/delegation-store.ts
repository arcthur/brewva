import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  type BrewvaRuntime,
  type BrewvaStructuredEvent,
  type DelegationArtifactRef,
  type DelegationDeliveryRecord,
  type DelegationModelRouteRecord,
  type DelegationRunQuery,
  type DelegationRunRecord,
  type DelegationRunStatus,
  type PendingDelegationOutcomeQuery,
  type ToolExecutionBoundary,
} from "@brewva/brewva-runtime";
import { isDelegationRunTerminalStatus } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { recordSessionTurnTransition } from "../session/turn-transition.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type DelegationEvent = Pick<BrewvaStructuredEvent, "sessionId" | "type" | "timestamp" | "payload">;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRunStatus(value: unknown): DelegationRunStatus | undefined {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "timeout" ||
    value === "cancelled" ||
    value === "merged"
    ? value
    : undefined;
}

function readDeliveryMode(value: unknown): DelegationDeliveryRecord["mode"] | undefined {
  return value === "text_only" || value === "supplemental" ? value : undefined;
}

function readHandoffState(value: unknown): DelegationDeliveryRecord["handoffState"] | undefined {
  return value === "none" || value === "pending_parent_turn" || value === "surfaced"
    ? value
    : undefined;
}

function readBoundary(value: unknown): ToolExecutionBoundary | undefined {
  return value === "safe" || value === "effectful" ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readEventPayload(event: DelegationEvent): Record<string, unknown> | null {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : null;
}

function cloneArtifactRef(ref: DelegationArtifactRef): DelegationArtifactRef {
  return {
    kind: ref.kind,
    path: ref.path,
    summary: ref.summary,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
}

function readJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (!isJsonValue(value)) {
    return undefined;
  }
  return structuredClone(value) as Record<string, JsonValue>;
}

function cloneJsonRecord(
  value: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
  return value ? structuredClone(value) : undefined;
}

function cloneModelRoute(route: DelegationModelRouteRecord): DelegationModelRouteRecord {
  return {
    selectedModel: route.selectedModel,
    source: route.source,
    mode: route.mode,
    reason: route.reason,
    policyId: route.policyId,
    requestedModel: route.requestedModel,
  };
}

export function cloneDelegationRunRecord(record: DelegationRunRecord): DelegationRunRecord {
  return {
    ...record,
    modelRoute: record.modelRoute ? cloneModelRoute(record.modelRoute) : undefined,
    resultData: cloneJsonRecord(record.resultData),
    artifactRefs: record.artifactRefs?.map((ref) => cloneArtifactRef(ref)),
    delivery: record.delivery
      ? {
          mode: record.delivery.mode,
          scopeId: record.delivery.scopeId,
          label: record.delivery.label,
          handoffState: record.delivery.handoffState,
          readyAt: record.delivery.readyAt,
          surfacedAt: record.delivery.surfacedAt,
          supplementalAppended: record.delivery.supplementalAppended,
          updatedAt: record.delivery.updatedAt,
        }
      : undefined,
  };
}

function readArtifactRefs(
  payload: Record<string, unknown> | null,
): DelegationArtifactRef[] | undefined {
  const raw = payload?.artifactRefs;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const refs = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const kind = readString((entry as { kind?: unknown }).kind);
    const path = readString((entry as { path?: unknown }).path);
    if (!kind || !path) {
      return [];
    }
    return [
      {
        kind,
        path,
        summary: readString((entry as { summary?: unknown }).summary),
      } satisfies DelegationArtifactRef,
    ];
  });
  return refs.length > 0 ? refs : undefined;
}

function readModelRoute(
  payload: Record<string, unknown> | null,
  existing: DelegationRunRecord | undefined,
): DelegationModelRouteRecord | undefined {
  const raw = payload?.modelRoute;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return existing?.modelRoute;
  }
  const selectedModel = readString((raw as { selectedModel?: unknown }).selectedModel);
  const source = (raw as { source?: unknown }).source;
  const mode = (raw as { mode?: unknown }).mode;
  const reason = readString((raw as { reason?: unknown }).reason);
  if (
    !selectedModel ||
    (source !== "execution_shape" && source !== "target" && source !== "policy") ||
    (mode !== "explicit" && mode !== "auto") ||
    !reason
  ) {
    return existing?.modelRoute;
  }
  return {
    selectedModel,
    source,
    mode,
    reason,
    policyId: readString((raw as { policyId?: unknown }).policyId),
    requestedModel: readString((raw as { requestedModel?: unknown }).requestedModel),
  };
}

function readRunMetadata(
  payload: Record<string, unknown> | null,
  existing: DelegationRunRecord | undefined,
): Pick<DelegationRunRecord, "agentSpec" | "envelope" | "skillName"> {
  return {
    agentSpec: readString(payload?.agentSpec) ?? existing?.agentSpec,
    envelope: readString(payload?.envelope) ?? existing?.envelope,
    skillName: readString(payload?.skillName) ?? existing?.skillName,
  };
}

function readDelegationKind(value: unknown): DelegationRunRecord["kind"] | undefined {
  if (value === "consult" || value === "qa" || value === "patch") {
    return value;
  }
  if (value === "exploration" || value === "plan" || value === "review") {
    return "consult";
  }
  return undefined;
}

function inferLegacyConsultKind(
  kindValue: unknown,
  payload: Record<string, unknown> | null,
  existing: DelegationRunRecord | undefined,
): DelegationRunRecord["consultKind"] | undefined {
  if (kindValue === "review") {
    return "review";
  }
  if (kindValue === "plan") {
    return "design";
  }
  if (kindValue !== "exploration") {
    return existing?.consultKind;
  }
  const delegatedSkill =
    readString(payload?.skillName) ??
    readString(payload?.parentSkill) ??
    existing?.skillName ??
    existing?.parentSkill;
  return delegatedSkill === "debugging" ? "diagnose" : "investigate";
}

function readDelegationConsultKind(
  value: unknown,
  payload: Record<string, unknown> | null,
  existing: DelegationRunRecord | undefined,
): DelegationRunRecord["consultKind"] | undefined {
  if (value === "investigate" || value === "diagnose" || value === "design" || value === "review") {
    return value;
  }
  return inferLegacyConsultKind(payload?.kind, payload, existing);
}

function mergeDeliveryRecord(
  payload: Record<string, unknown> | null,
  existing: DelegationDeliveryRecord | undefined,
  fallbackTimestamp: number,
): DelegationDeliveryRecord | undefined {
  const mode = readDeliveryMode(payload?.deliveryMode) ?? existing?.mode;
  if (!mode) {
    return undefined;
  }
  const supplementalAppended =
    typeof payload?.supplementalAppended === "boolean"
      ? payload.supplementalAppended
      : existing?.supplementalAppended;
  const updatedAt = readNonNegativeNumber(payload?.deliveryUpdatedAt) ?? fallbackTimestamp;
  return {
    mode,
    scopeId: readString(payload?.deliveryScopeId) ?? existing?.scopeId,
    label: readString(payload?.deliveryLabel) ?? existing?.label,
    handoffState: readHandoffState(payload?.deliveryHandoffState) ?? existing?.handoffState,
    readyAt: readNonNegativeNumber(payload?.deliveryReadyAt) ?? existing?.readyAt,
    surfacedAt: readNonNegativeNumber(payload?.deliverySurfacedAt) ?? existing?.surfacedAt,
    supplementalAppended,
    updatedAt: updatedAt ?? existing?.updatedAt,
  };
}

function upsertRun(
  runs: Map<string, DelegationRunRecord>,
  record: DelegationRunRecord,
): DelegationRunRecord {
  const cloned = cloneDelegationRunRecord(record);
  runs.set(cloned.runId, cloned);
  return cloned;
}

export function buildDelegationLifecyclePayload(
  record: DelegationRunRecord,
): Record<string, unknown> {
  return {
    runId: record.runId,
    delegate: record.delegate,
    agentSpec: record.agentSpec ?? null,
    envelope: record.envelope ?? null,
    skillName: record.skillName ?? null,
    label: record.label ?? null,
    kind: record.kind ?? null,
    consultKind: record.consultKind ?? null,
    boundary: record.boundary ?? null,
    parentSkill: record.parentSkill ?? null,
    childSessionId: record.workerSessionId ?? null,
    status: record.status,
    summary: record.summary ?? null,
    error: record.error ?? null,
    resultData: record.resultData ?? null,
    artifactRefs: record.artifactRefs ?? [],
    totalTokens: record.totalTokens ?? null,
    costUsd: record.costUsd ?? null,
    modelRoute: record.modelRoute ?? null,
    deliveryMode: record.delivery?.mode ?? null,
    deliveryScopeId: record.delivery?.scopeId ?? null,
    deliveryLabel: record.delivery?.label ?? null,
    deliveryHandoffState: record.delivery?.handoffState ?? null,
    deliveryReadyAt: record.delivery?.readyAt ?? null,
    deliverySurfacedAt: record.delivery?.surfacedAt ?? null,
    supplementalAppended: record.delivery?.supplementalAppended ?? null,
    deliveryUpdatedAt: record.delivery?.updatedAt ?? null,
  };
}

function applyDelegationEvent(
  runs: Map<string, DelegationRunRecord>,
  event: DelegationEvent,
): void {
  const payload = readEventPayload(event);
  if (event.type === SUBAGENT_SPAWNED_EVENT_TYPE || event.type === SUBAGENT_RUNNING_EVENT_TYPE) {
    const runId = readString(payload?.runId);
    const delegate = readString(payload?.delegate);
    if (!runId || !delegate) {
      return;
    }
    const existing = runs.get(runId);
    upsertRun(runs, {
      runId,
      delegate,
      ...readRunMetadata(payload, existing),
      parentSessionId: event.sessionId,
      status:
        readRunStatus(payload?.status) ??
        (event.type === SUBAGENT_RUNNING_EVENT_TYPE ? "running" : "pending"),
      createdAt: existing?.createdAt ?? event.timestamp,
      updatedAt: event.timestamp,
      label: readString(payload?.label) ?? existing?.label,
      workerSessionId: readString(payload?.childSessionId) ?? existing?.workerSessionId,
      parentSkill: readString(payload?.parentSkill) ?? existing?.parentSkill,
      kind: readDelegationKind(payload?.kind) ?? existing?.kind,
      consultKind: readDelegationConsultKind(payload?.consultKind, payload, existing),
      boundary: readBoundary(payload?.boundary) ?? existing?.boundary,
      modelRoute: readModelRoute(payload, existing),
      summary: existing?.summary,
      error: existing?.error,
      resultData: existing?.resultData,
      artifactRefs: existing?.artifactRefs,
      delivery: mergeDeliveryRecord(payload, existing?.delivery, event.timestamp),
      totalTokens: existing?.totalTokens,
      costUsd: existing?.costUsd,
    });
    return;
  }

  if (event.type === SUBAGENT_COMPLETED_EVENT_TYPE) {
    const runId = readString(payload?.runId);
    if (!runId) {
      return;
    }
    const existing = runs.get(runId);
    upsertRun(runs, {
      runId,
      delegate: readString(payload?.delegate) ?? existing?.delegate ?? "unknown",
      ...readRunMetadata(payload, existing),
      parentSessionId: event.sessionId,
      status: "completed",
      createdAt: existing?.createdAt ?? event.timestamp,
      updatedAt: event.timestamp,
      label: readString(payload?.label) ?? existing?.label,
      workerSessionId: readString(payload?.childSessionId) ?? existing?.workerSessionId,
      parentSkill: readString(payload?.parentSkill) ?? existing?.parentSkill,
      kind: readDelegationKind(payload?.kind) ?? existing?.kind,
      consultKind: readDelegationConsultKind(payload?.consultKind, payload, existing),
      boundary: readBoundary(payload?.boundary) ?? existing?.boundary,
      modelRoute: readModelRoute(payload, existing),
      summary: readString(payload?.summary) ?? existing?.summary,
      error: undefined,
      resultData: readJsonRecord(payload?.resultData) ?? existing?.resultData,
      artifactRefs: readArtifactRefs(payload) ?? existing?.artifactRefs,
      delivery: mergeDeliveryRecord(payload, existing?.delivery, event.timestamp),
      totalTokens: readNonNegativeNumber(payload?.totalTokens) ?? existing?.totalTokens,
      costUsd:
        typeof payload?.costUsd === "number" && Number.isFinite(payload.costUsd)
          ? Math.max(0, payload.costUsd)
          : existing?.costUsd,
    });
    return;
  }

  if (event.type === SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE) {
    const runId = readString(payload?.runId);
    if (!runId) {
      return;
    }
    const existing = runs.get(runId);
    if (!existing) {
      return;
    }
    upsertRun(runs, {
      ...existing,
      updatedAt: event.timestamp,
      modelRoute: readModelRoute(payload, existing),
      resultData: readJsonRecord(payload?.resultData) ?? existing.resultData,
      delivery: mergeDeliveryRecord(payload, existing.delivery, event.timestamp),
    });
    return;
  }

  if (event.type === SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE) {
    const runId = readString(payload?.runId);
    if (!runId) {
      return;
    }
    const existing = runs.get(runId);
    if (!existing) {
      return;
    }
    upsertRun(runs, {
      ...existing,
      updatedAt: event.timestamp,
      modelRoute: readModelRoute(payload, existing),
      resultData: readJsonRecord(payload?.resultData) ?? existing.resultData,
      delivery: mergeDeliveryRecord(payload, existing.delivery, event.timestamp),
    });
    return;
  }

  if (event.type === SUBAGENT_FAILED_EVENT_TYPE || event.type === SUBAGENT_CANCELLED_EVENT_TYPE) {
    const runId = readString(payload?.runId);
    if (!runId) {
      return;
    }
    const existing = runs.get(runId);
    const statusFromPayload = readRunStatus(payload?.status);
    const fallbackError =
      statusFromPayload === "timeout"
        ? "timeout"
        : event.type === SUBAGENT_CANCELLED_EVENT_TYPE
          ? "cancelled"
          : "failed";
    upsertRun(runs, {
      runId,
      delegate: readString(payload?.delegate) ?? existing?.delegate ?? "unknown",
      ...readRunMetadata(payload, existing),
      parentSessionId: event.sessionId,
      status:
        statusFromPayload ??
        (event.type === SUBAGENT_CANCELLED_EVENT_TYPE ? "cancelled" : "failed"),
      createdAt: existing?.createdAt ?? event.timestamp,
      updatedAt: event.timestamp,
      label: readString(payload?.label) ?? existing?.label,
      workerSessionId: readString(payload?.childSessionId) ?? existing?.workerSessionId,
      parentSkill: readString(payload?.parentSkill) ?? existing?.parentSkill,
      kind: readDelegationKind(payload?.kind) ?? existing?.kind,
      consultKind: readDelegationConsultKind(payload?.consultKind, payload, existing),
      boundary: readBoundary(payload?.boundary) ?? existing?.boundary,
      modelRoute: readModelRoute(payload, existing),
      summary: readString(payload?.summary) ?? existing?.summary,
      error:
        readString(payload?.error) ??
        readString(payload?.reason) ??
        existing?.error ??
        fallbackError,
      resultData: readJsonRecord(payload?.resultData) ?? existing?.resultData,
      artifactRefs: readArtifactRefs(payload) ?? existing?.artifactRefs,
      delivery: mergeDeliveryRecord(payload, existing?.delivery, event.timestamp),
      totalTokens: readNonNegativeNumber(payload?.totalTokens) ?? existing?.totalTokens,
      costUsd:
        typeof payload?.costUsd === "number" && Number.isFinite(payload.costUsd)
          ? Math.max(0, payload.costUsd)
          : existing?.costUsd,
    });
    return;
  }

  if (event.type !== WORKER_RESULTS_APPLIED_EVENT_TYPE) {
    return;
  }

  const workerIds = Array.isArray(payload?.workerIds)
    ? payload.workerIds.flatMap((value) =>
        typeof value === "string" && value.trim() ? [value] : [],
      )
    : [];
  if (workerIds.length === 0) {
    return;
  }
  for (const runId of workerIds) {
    const existing = runs.get(runId);
    if (!existing) {
      continue;
    }
    upsertRun(runs, {
      ...existing,
      status: "merged",
      updatedAt: event.timestamp,
    });
  }
}

function filterDelegationRuns(
  runs: Iterable<DelegationRunRecord>,
  query: DelegationRunQuery = {},
): DelegationRunRecord[] {
  const runIdFilter =
    Array.isArray(query.runIds) && query.runIds.length > 0 ? new Set(query.runIds) : undefined;
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
  private readonly sessionRuns = new Map<string, Map<string, DelegationRunRecord>>();
  private readonly hydratedSessions = new Set<string>();
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    private readonly runtime: BrewvaRuntime,
    options: {
      subscribe?: boolean;
    } = {},
  ) {
    if (options.subscribe !== false) {
      this.unsubscribe = runtime.inspect.events.subscribe((event) => {
        const runs = this.sessionRuns.get(event.sessionId);
        if (!runs || !this.hydratedSessions.has(event.sessionId)) {
          return;
        }
        applyDelegationEvent(runs, event);
      });
    }
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  clearSession(sessionId: string): void {
    this.sessionRuns.delete(sessionId);
    this.hydratedSessions.delete(sessionId);
  }

  getRun(sessionId: string, runId: string): DelegationRunRecord | undefined {
    this.ensureHydrated(sessionId);
    const record = this.getOrCreateRuns(sessionId).get(runId);
    return record ? cloneDelegationRunRecord(record) : undefined;
  }

  listRuns(sessionId: string, query: DelegationRunQuery = {}): DelegationRunRecord[] {
    this.ensureHydrated(sessionId);
    return filterDelegationRuns(this.getOrCreateRuns(sessionId).values(), query);
  }

  listPendingOutcomes(
    sessionId: string,
    query: PendingDelegationOutcomeQuery = {},
  ): DelegationRunRecord[] {
    this.ensureHydrated(sessionId);
    const pending = [...this.getOrCreateRuns(sessionId).values()]
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
      recordRuntimeEvent(this.runtime, {
        sessionId: input.sessionId,
        turn: input.turn,
        type: SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
        payload: buildDelegationLifecyclePayload(updated),
      });
      recordSessionTurnTransition(this.runtime, {
        sessionId: input.sessionId,
        turn: input.turn,
        reason: "subagent_delivery_pending",
        status: "completed",
        family: "delegation",
      });
    }
  }

  private getOrCreateRuns(sessionId: string): Map<string, DelegationRunRecord> {
    const existing = this.sessionRuns.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, DelegationRunRecord>();
    this.sessionRuns.set(sessionId, created);
    return created;
  }

  private ensureHydrated(sessionId: string): void {
    if (this.hydratedSessions.has(sessionId)) {
      return;
    }
    const runs = this.getOrCreateRuns(sessionId);
    runs.clear();
    for (const event of this.runtime.inspect.events.queryStructured(sessionId)) {
      applyDelegationEvent(runs, event);
    }
    this.hydratedSessions.add(sessionId);
  }
}
