import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  type BrewvaRuntime,
  type BrewvaStructuredEvent,
  type DelegationArtifactRef,
  type DelegationDeliveryRecord,
  type DelegationRunQuery,
  type DelegationRunRecord,
  type DelegationRunStatus,
  type PendingDelegationOutcomeQuery,
  type ToolExecutionBoundary,
} from "@brewva/brewva-runtime";

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

export function cloneDelegationRunRecord(record: DelegationRunRecord): DelegationRunRecord {
  return {
    ...record,
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

function isTerminalStatus(status: DelegationRunRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled" ||
    status === "merged"
  );
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
    boundary: record.boundary ?? null,
    parentSkill: record.parentSkill ?? null,
    childSessionId: record.workerSessionId ?? null,
    status: record.status,
    summary: record.summary ?? null,
    error: record.error ?? null,
    artifactRefs: record.artifactRefs ?? [],
    totalTokens: record.totalTokens ?? null,
    costUsd: record.costUsd ?? null,
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
  if (event.type === SUBAGENT_SPAWNED_EVENT_TYPE) {
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
      status: readRunStatus(payload?.status) ?? "running",
      createdAt: existing?.createdAt ?? event.timestamp,
      updatedAt: event.timestamp,
      label: readString(payload?.label) ?? existing?.label,
      workerSessionId: readString(payload?.childSessionId) ?? existing?.workerSessionId,
      parentSkill: readString(payload?.parentSkill) ?? existing?.parentSkill,
      kind:
        readString(payload?.kind) === "exploration" ||
        readString(payload?.kind) === "review" ||
        readString(payload?.kind) === "verification" ||
        readString(payload?.kind) === "patch"
          ? (readString(payload?.kind) as DelegationRunRecord["kind"])
          : existing?.kind,
      boundary: readBoundary(payload?.boundary) ?? existing?.boundary,
      summary: existing?.summary,
      error: existing?.error,
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
      kind:
        readString(payload?.kind) === "exploration" ||
        readString(payload?.kind) === "review" ||
        readString(payload?.kind) === "verification" ||
        readString(payload?.kind) === "patch"
          ? (readString(payload?.kind) as DelegationRunRecord["kind"])
          : existing?.kind,
      boundary: readBoundary(payload?.boundary) ?? existing?.boundary,
      summary: readString(payload?.summary) ?? existing?.summary,
      error: undefined,
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
      kind:
        readString(payload?.kind) === "exploration" ||
        readString(payload?.kind) === "review" ||
        readString(payload?.kind) === "verification" ||
        readString(payload?.kind) === "patch"
          ? (readString(payload?.kind) as DelegationRunRecord["kind"])
          : existing?.kind,
      boundary: readBoundary(payload?.boundary) ?? existing?.boundary,
      summary: readString(payload?.summary) ?? existing?.summary,
      error:
        readString(payload?.error) ??
        readString(payload?.reason) ??
        existing?.error ??
        fallbackError,
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
      if (!includeTerminal && isTerminalStatus(record.status)) {
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
      this.unsubscribe = runtime.events.subscribe((event) => {
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
      this.runtime.events.record({
        sessionId: input.sessionId,
        turn: input.turn,
        type: SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
        payload: buildDelegationLifecyclePayload(updated),
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
    for (const event of this.runtime.events.queryStructured(sessionId)) {
      applyDelegationEvent(runs, event);
    }
    this.hydratedSessions.add(sessionId);
  }
}
