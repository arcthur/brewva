import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-runtime/delegation";
import type {
  DelegationAdoptionRecord,
  DelegationExecutionPrimitive,
  DelegationGateReason,
  DelegationIsolationStrategy,
  DelegationLifecycleEventPayload,
  DelegationLineageRecord,
  DelegationArtifactRef,
  DelegationDeliveryRecord,
  DelegationModelCategory,
  DelegationModelRouteRecord,
  DelegationRunQuery,
  DelegationRunRecord,
  DelegationVisibility,
  PendingDelegationOutcomeQuery,
  PublicSubagentRole,
} from "@brewva/brewva-runtime/delegation";
import { isDelegationRunTerminalStatus } from "@brewva/brewva-runtime/delegation";
import { type BrewvaStructuredEvent } from "@brewva/brewva-runtime/events";
import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  readDelegationLifecycleEventPayload,
  readWorkerResultsAppliedEventPayload,
} from "@brewva/brewva-runtime/events";
import { recordSessionTurnTransition } from "../hosted/api.js";
import { adoptDelegationLineageOutcome } from "./lineage.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type DelegationEvent = Pick<BrewvaStructuredEvent, "sessionId" | "type" | "timestamp" | "payload">;

function cloneArtifactRef(ref: DelegationArtifactRef): DelegationArtifactRef {
  return {
    kind: ref.kind,
    path: ref.path,
    summary: ref.summary,
  };
}

function cloneJsonRecord(
  value: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
  return value ? structuredClone(value) : undefined;
}

function cloneModelRoute(route: DelegationModelRouteRecord): DelegationModelRouteRecord {
  return {
    selectedModel: route.selectedModel,
    category: route.category,
    source: route.source,
    mode: route.mode,
    reason: route.reason,
    policyId: route.policyId,
    presetName: route.presetName,
  };
}

function cloneAdoption(adoption: DelegationAdoptionRecord): DelegationAdoptionRecord {
  return {
    contractId: adoption.contractId,
    decision: adoption.decision,
    reason: adoption.reason,
    requiredEvidence: adoption.requiredEvidence ? [...adoption.requiredEvidence] : undefined,
  };
}

function cloneLineage(lineage: DelegationLineageRecord): DelegationLineageRecord {
  return {
    parentSessionId: lineage.parentSessionId,
    forkTurns: lineage.forkTurns,
  };
}

function readRawEventPayload(event: DelegationEvent): Record<string, unknown> | null {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : null;
}

function normalizeHistoricalTaskPathSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "run";
}

function isLegacyDelegationContractVersion(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === 1 ||
    value === 2 ||
    value === "1" ||
    value === "2"
  );
}

function resolveDelegationContractVersion(
  event: DelegationEvent,
  payload: DelegationLifecycleEventPayload,
): {
  contractVersion: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  historicallyNormalized: boolean;
} {
  if (payload.contractVersion === CURRENT_DELEGATION_CONTRACT_VERSION) {
    return {
      contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
      historicallyNormalized: false,
    };
  }
  const raw = readRawEventPayload(event);
  const value = raw?.contractVersion;
  if (isLegacyDelegationContractVersion(value)) {
    return {
      contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
      historicallyNormalized: true,
    };
  }
  const rendered =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "missing";
  throw new Error(`unsupported_delegation_contract_version:${rendered}`);
}

function normalizeHistoricalAgent(
  payload: DelegationLifecycleEventPayload,
  raw: Record<string, unknown> | null,
): PublicSubagentRole {
  const candidates = [payload.agent, raw?.agent, raw?.targetName, raw?.delegate];
  for (const candidate of candidates) {
    if (
      candidate === "navigator" ||
      candidate === "explorer" ||
      candidate === "worker" ||
      candidate === "verifier" ||
      candidate === "librarian"
    ) {
      return candidate;
    }
    if (candidate === "advisor") {
      return "explorer";
    }
    if (candidate === "patch-worker") {
      return "worker";
    }
    if (candidate === "qa") {
      return "verifier";
    }
  }
  return "explorer";
}

function defaultGateReasonForAgent(agent: PublicSubagentRole): DelegationGateReason {
  switch (agent) {
    case "navigator":
      return "find_evidence";
    case "worker":
      return "implement_isolated";
    case "verifier":
      return "verify_reproducibly";
    case "librarian":
      return "compound_knowledge";
    case "explorer":
      return "make_judgment";
  }
  return "make_judgment";
}

function defaultModelCategoryForAgent(agent: PublicSubagentRole): DelegationModelCategory {
  switch (agent) {
    case "navigator":
      return "fast-evidence";
    case "worker":
      return "isolated-execution";
    case "verifier":
      return "verification";
    case "librarian":
      return "knowledge";
    case "explorer":
      return "deep-reasoning";
  }
  return "deep-reasoning";
}

function defaultKindForAgent(agent: PublicSubagentRole): DelegationRunRecord["kind"] {
  switch (agent) {
    case "navigator":
      return "evidence";
    case "worker":
      return "patch";
    case "verifier":
      return "verifier";
    case "librarian":
      return "knowledge";
    case "explorer":
      return "consult";
  }
  return "consult";
}

function requireDelegationAdoption(
  payload: DelegationLifecycleEventPayload,
  runId: string,
  historicallyNormalized: boolean,
  kind: DelegationRunRecord["kind"],
): DelegationAdoptionRecord {
  if (payload.adoption) {
    return payload.adoption;
  }
  if (historicallyNormalized) {
    return {
      contractId: `delegation.${kind ?? "consult"}`,
      decision: "require_human",
      reason: "historical delegation record normalized without a v3 adoption contract",
    };
  }
  throw new Error(`invalid_delegation_contract:${runId}:missing_adoption`);
}

function requireV3IdentityFields(
  payload: DelegationLifecycleEventPayload,
  existing: DelegationRunRecord | undefined,
  runId: string,
  input: {
    historicallyNormalized: boolean;
    raw: Record<string, unknown> | null;
  },
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
  const agent = payload.agent ?? existing?.agent;
  const targetName = payload.targetName ?? existing?.targetName;
  const taskName = payload.taskName ?? existing?.taskName;
  const taskPath = payload.taskPath ?? existing?.taskPath;
  const nickname = payload.nickname ?? existing?.nickname;
  const depth = payload.depth ?? existing?.depth;
  const forkTurns = payload.forkTurns ?? existing?.forkTurns;
  const gateReason = payload.gateReason ?? existing?.gateReason;
  const modelCategory = payload.modelCategory ?? existing?.modelCategory;
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
    if (input.historicallyNormalized) {
      const historicalAgent = normalizeHistoricalAgent(payload, input.raw);
      const historicalTaskName =
        payload.taskName ??
        (typeof input.raw?.taskName === "string" ? input.raw.taskName : undefined) ??
        payload.label ??
        payload.delegate ??
        existing?.taskName ??
        runId;
      const historicalTaskPath =
        payload.taskPath ??
        existing?.taskPath ??
        `/historical/${normalizeHistoricalTaskPathSegment(runId)}`;
      return {
        agent: historicalAgent,
        targetName: payload.targetName ?? existing?.targetName ?? historicalAgent,
        taskName: historicalTaskName,
        taskPath: historicalTaskPath,
        nickname:
          payload.nickname ??
          existing?.nickname ??
          payload.label ??
          payload.delegate ??
          historicalTaskName,
        depth: payload.depth ?? existing?.depth ?? 2,
        forkTurns: payload.forkTurns ?? existing?.forkTurns ?? "none",
        gateReason:
          payload.gateReason ?? existing?.gateReason ?? defaultGateReasonForAgent(historicalAgent),
        modelCategory:
          payload.modelCategory ??
          existing?.modelCategory ??
          defaultModelCategoryForAgent(historicalAgent),
      };
    }
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
  existing: DelegationRunRecord | undefined,
  runId: string,
  input: {
    historicallyNormalized: boolean;
    agent: PublicSubagentRole;
  },
): {
  executionPrimitive: DelegationExecutionPrimitive;
  visibility: DelegationVisibility;
  isolationStrategy: DelegationIsolationStrategy;
} {
  const executionPrimitive = payload.executionPrimitive ?? existing?.executionPrimitive;
  const visibility = payload.visibility ?? existing?.visibility;
  const isolationStrategy = payload.isolationStrategy ?? existing?.isolationStrategy;
  if (executionPrimitive && visibility && isolationStrategy) {
    return {
      executionPrimitive,
      visibility,
      isolationStrategy,
    };
  }
  if (!input.historicallyNormalized) {
    throw new Error(`invalid_delegation_contract:${runId}`);
  }
  return {
    executionPrimitive: executionPrimitive ?? "named",
    visibility: visibility ?? "public",
    isolationStrategy: isolationStrategy ?? (input.agent === "worker" ? "snapshot" : "shared"),
  };
}

function mergeDeliveryRecord(
  payload: Pick<DelegationLifecycleEventPayload, "delivery">,
  existing: DelegationDeliveryRecord | undefined,
  fallbackTimestamp: number,
): DelegationDeliveryRecord | undefined {
  const incoming = payload.delivery;
  if (!incoming) {
    return existing;
  }
  return {
    mode: incoming.mode,
    scopeId: incoming.scopeId ?? existing?.scopeId,
    label: incoming.label ?? existing?.label,
    handoffState: incoming.handoffState ?? existing?.handoffState,
    readyAt: incoming.readyAt ?? existing?.readyAt,
    surfacedAt: incoming.surfacedAt ?? existing?.surfacedAt,
    supplementalAppended: incoming.supplementalAppended ?? existing?.supplementalAppended,
    updatedAt: incoming.updatedAt ?? fallbackTimestamp,
  };
}

export function cloneDelegationRunRecord(record: DelegationRunRecord): DelegationRunRecord {
  return {
    ...record,
    adoption: cloneAdoption(record.adoption),
    lineage: record.lineage ? cloneLineage(record.lineage) : undefined,
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
    contractVersion: record.contractVersion,
    runId: record.runId,
    agent: record.agent,
    targetName: record.targetName,
    delegate: record.delegate,
    taskName: record.taskName,
    taskPath: record.taskPath,
    nickname: record.nickname,
    depth: record.depth,
    forkTurns: record.forkTurns,
    gateReason: record.gateReason,
    modelCategory: record.modelCategory,
    executionPrimitive: record.executionPrimitive,
    visibility: record.visibility,
    isolationStrategy: record.isolationStrategy,
    adoption: record.adoption,
    lineage: record.lineage ?? null,
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
  if (event.type === SUBAGENT_SPAWNED_EVENT_TYPE || event.type === SUBAGENT_RUNNING_EVENT_TYPE) {
    const payload = readDelegationLifecycleEventPayload(event);
    if (!payload?.runId) {
      return;
    }
    const runId = payload.runId;
    const existing = runs.get(runId);
    const contract = resolveDelegationContractVersion(event, payload);
    const identityFields = requireV3IdentityFields(payload, existing, runId, {
      historicallyNormalized: contract.historicallyNormalized,
      raw: readRawEventPayload(event),
    });
    const executionFields = requireExecutionContractFields(payload, existing, runId, {
      historicallyNormalized: contract.historicallyNormalized,
      agent: identityFields.agent,
    });
    const kind =
      payload.kind ??
      existing?.kind ??
      (contract.historicallyNormalized ? defaultKindForAgent(identityFields.agent) : undefined);
    upsertRun(runs, {
      contractVersion: contract.contractVersion,
      runId,
      ...identityFields,
      delegate: payload.delegate ?? existing?.delegate ?? identityFields.targetName,
      ...executionFields,
      adoption: requireDelegationAdoption(payload, runId, contract.historicallyNormalized, kind),
      historicallyNormalized:
        contract.historicallyNormalized || existing?.historicallyNormalized ? true : undefined,
      lineage: payload.lineage ?? existing?.lineage,
      agentSpec: payload.agentSpec ?? existing?.agentSpec,
      envelope: payload.envelope ?? existing?.envelope,
      skillName: payload.skillName ?? existing?.skillName,
      parentSessionId: event.sessionId,
      status:
        payload.status ?? (event.type === SUBAGENT_RUNNING_EVENT_TYPE ? "running" : "pending"),
      createdAt: existing?.createdAt ?? event.timestamp,
      updatedAt: event.timestamp,
      label: payload.label ?? existing?.label,
      workerSessionId: payload.childSessionId ?? existing?.workerSessionId,
      parentSkill: payload.parentSkill ?? existing?.parentSkill,
      kind,
      consultKind: payload.consultKind ?? existing?.consultKind,
      boundary: payload.boundary ?? existing?.boundary,
      modelRoute: payload.modelRoute ?? existing?.modelRoute,
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
    const payload = readDelegationLifecycleEventPayload(event);
    if (!payload?.runId) {
      return;
    }
    const runId = payload.runId;
    const existing = runs.get(runId);
    const contract = resolveDelegationContractVersion(event, payload);
    const identityFields = requireV3IdentityFields(payload, existing, runId, {
      historicallyNormalized: contract.historicallyNormalized,
      raw: readRawEventPayload(event),
    });
    const executionFields = requireExecutionContractFields(payload, existing, runId, {
      historicallyNormalized: contract.historicallyNormalized,
      agent: identityFields.agent,
    });
    const kind =
      payload.kind ??
      existing?.kind ??
      (contract.historicallyNormalized ? defaultKindForAgent(identityFields.agent) : undefined);
    upsertRun(runs, {
      contractVersion: contract.contractVersion,
      runId,
      ...identityFields,
      delegate: payload.delegate ?? existing?.delegate ?? "unknown",
      ...executionFields,
      adoption: requireDelegationAdoption(payload, runId, contract.historicallyNormalized, kind),
      historicallyNormalized:
        contract.historicallyNormalized || existing?.historicallyNormalized ? true : undefined,
      lineage: payload.lineage ?? existing?.lineage,
      agentSpec: payload.agentSpec ?? existing?.agentSpec,
      envelope: payload.envelope ?? existing?.envelope,
      skillName: payload.skillName ?? existing?.skillName,
      parentSessionId: event.sessionId,
      status: "completed",
      createdAt: existing?.createdAt ?? event.timestamp,
      updatedAt: event.timestamp,
      label: payload.label ?? existing?.label,
      workerSessionId: payload.childSessionId ?? existing?.workerSessionId,
      parentSkill: payload.parentSkill ?? existing?.parentSkill,
      kind,
      consultKind: payload.consultKind ?? existing?.consultKind,
      boundary: payload.boundary ?? existing?.boundary,
      modelRoute: payload.modelRoute ?? existing?.modelRoute,
      summary: payload.summary ?? existing?.summary,
      error: undefined,
      resultData: payload.resultData ?? existing?.resultData,
      artifactRefs: payload.artifactRefs ?? existing?.artifactRefs,
      delivery: mergeDeliveryRecord(payload, existing?.delivery, event.timestamp),
      totalTokens: payload.totalTokens ?? existing?.totalTokens,
      costUsd: payload.costUsd ?? existing?.costUsd,
    });
    return;
  }

  if (event.type === SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE) {
    const payload = readDelegationLifecycleEventPayload(event);
    if (!payload?.runId) {
      return;
    }
    const existing = runs.get(payload.runId);
    if (!existing) {
      return;
    }
    upsertRun(runs, {
      ...existing,
      updatedAt: event.timestamp,
      modelRoute: payload.modelRoute ?? existing.modelRoute,
      resultData: payload.resultData ?? existing.resultData,
      delivery: mergeDeliveryRecord(payload, existing.delivery, event.timestamp),
    });
    return;
  }

  if (event.type === SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE) {
    const payload = readDelegationLifecycleEventPayload(event);
    if (!payload?.runId) {
      return;
    }
    const existing = runs.get(payload.runId);
    if (!existing) {
      return;
    }
    upsertRun(runs, {
      ...existing,
      updatedAt: event.timestamp,
      modelRoute: payload.modelRoute ?? existing.modelRoute,
      resultData: payload.resultData ?? existing.resultData,
      delivery: mergeDeliveryRecord(payload, existing.delivery, event.timestamp),
    });
    return;
  }

  if (event.type === SUBAGENT_FAILED_EVENT_TYPE || event.type === SUBAGENT_CANCELLED_EVENT_TYPE) {
    const payload = readDelegationLifecycleEventPayload(event);
    if (!payload?.runId) {
      return;
    }
    const runId = payload.runId;
    const existing = runs.get(runId);
    const contract = resolveDelegationContractVersion(event, payload);
    const identityFields = requireV3IdentityFields(payload, existing, runId, {
      historicallyNormalized: contract.historicallyNormalized,
      raw: readRawEventPayload(event),
    });
    const executionFields = requireExecutionContractFields(payload, existing, runId, {
      historicallyNormalized: contract.historicallyNormalized,
      agent: identityFields.agent,
    });
    const kind =
      payload.kind ??
      existing?.kind ??
      (contract.historicallyNormalized ? defaultKindForAgent(identityFields.agent) : undefined);
    const statusFromPayload = payload.status;
    const fallbackError =
      statusFromPayload === "timeout"
        ? "timeout"
        : event.type === SUBAGENT_CANCELLED_EVENT_TYPE
          ? "cancelled"
          : "failed";
    upsertRun(runs, {
      contractVersion: contract.contractVersion,
      runId,
      ...identityFields,
      delegate: payload.delegate ?? existing?.delegate ?? "unknown",
      ...executionFields,
      adoption: requireDelegationAdoption(payload, runId, contract.historicallyNormalized, kind),
      historicallyNormalized:
        contract.historicallyNormalized || existing?.historicallyNormalized ? true : undefined,
      lineage: payload.lineage ?? existing?.lineage,
      agentSpec: payload.agentSpec ?? existing?.agentSpec,
      envelope: payload.envelope ?? existing?.envelope,
      skillName: payload.skillName ?? existing?.skillName,
      parentSessionId: event.sessionId,
      status:
        statusFromPayload ??
        (event.type === SUBAGENT_CANCELLED_EVENT_TYPE ? "cancelled" : "failed"),
      createdAt: existing?.createdAt ?? event.timestamp,
      updatedAt: event.timestamp,
      label: payload.label ?? existing?.label,
      workerSessionId: payload.childSessionId ?? existing?.workerSessionId,
      parentSkill: payload.parentSkill ?? existing?.parentSkill,
      kind,
      consultKind: payload.consultKind ?? existing?.consultKind,
      boundary: payload.boundary ?? existing?.boundary,
      modelRoute: payload.modelRoute ?? existing?.modelRoute,
      summary: payload.summary ?? existing?.summary,
      error: payload.error ?? payload.reason ?? existing?.error ?? fallbackError,
      resultData: payload.resultData ?? existing?.resultData,
      artifactRefs: payload.artifactRefs ?? existing?.artifactRefs,
      delivery: mergeDeliveryRecord(payload, existing?.delivery, event.timestamp),
      totalTokens: payload.totalTokens ?? existing?.totalTokens,
      costUsd: payload.costUsd ?? existing?.costUsd,
    });
    return;
  }

  if (event.type !== WORKER_RESULTS_APPLIED_EVENT_TYPE) {
    return;
  }

  const payload = readWorkerResultsAppliedEventPayload(event);
  if (!payload) {
    return;
  }
  for (const runId of payload.workerIds) {
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

function adoptAppliedWorkerResultOutcomes(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  runs: Map<string, DelegationRunRecord>;
  event: DelegationEvent;
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
  private readonly sessionRuns = new Map<string, Map<string, DelegationRunRecord>>();
  private readonly hydratedSessions = new Set<string>();
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    private readonly runtime: BrewvaHostedRuntimePort,
    options: {
      subscribe?: boolean;
    } = {},
  ) {
    if (options.subscribe !== false) {
      this.unsubscribe = runtime.inspect.events.records.subscribe((event) => {
        const runs = this.sessionRuns.get(event.sessionId);
        if (!runs || !this.hydratedSessions.has(event.sessionId)) {
          return;
        }
        applyDelegationEvent(runs, event);
        adoptAppliedWorkerResultOutcomes({
          runtime: this.runtime,
          sessionId: event.sessionId,
          runs,
          event,
        });
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
      this.runtime.extensions.hosted.events.record({
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
    for (const event of this.runtime.inspect.events.records.queryStructured(sessionId)) {
      applyDelegationEvent(runs, event);
    }
    this.hydratedSessions.add(sessionId);
  }
}
