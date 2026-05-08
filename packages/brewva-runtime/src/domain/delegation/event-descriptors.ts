import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  asRecord,
  readJsonRecord,
  readNonNegativeNumber,
  readString,
} from "../../events/descriptor-codecs.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventLike,
} from "../../events/descriptor-core.js";
import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
} from "./events.js";
import type {
  DelegationAdoptionRecord,
  DelegationArtifactRef,
  DelegationDeliveryRecord,
  DelegationLifecycleEventPayload,
  DelegationLineageRecord,
  DelegationModelRouteRecord,
  WorkerResultsAppliedEventPayload,
} from "./types.js";
import { CURRENT_DELEGATION_CONTRACT_VERSION as DELEGATION_CONTRACT_VERSION } from "./types.js";

export {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
} from "./events.js";

function isToolExecutionBoundary(value: unknown): value is "safe" | "effectful" {
  return value === "safe" || value === "effectful";
}

function isDelegationRunStatus(
  value: unknown,
): value is NonNullable<DelegationLifecycleEventPayload["status"]> {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "timeout" ||
    value === "cancelled" ||
    value === "merged"
  );
}

function isDelegationDeliveryMode(
  value: unknown,
): value is NonNullable<DelegationDeliveryRecord["mode"]> {
  return value === "text_only" || value === "supplemental";
}

function isDelegationDeliveryHandoffState(
  value: unknown,
): value is NonNullable<DelegationDeliveryRecord["handoffState"]> {
  return value === "none" || value === "pending_parent_turn" || value === "surfaced";
}

function isDelegationExecutionPrimitive(
  value: unknown,
): value is NonNullable<DelegationLifecycleEventPayload["executionPrimitive"]> {
  return value === "named" || value === "fork";
}

function isDelegationVisibility(
  value: unknown,
): value is NonNullable<DelegationLifecycleEventPayload["visibility"]> {
  return value === "public" || value === "internal" || value === "diagnostic";
}

function isDelegationIsolationStrategy(
  value: unknown,
): value is NonNullable<DelegationLifecycleEventPayload["isolationStrategy"]> {
  return (
    value === "shared" ||
    value === "ephemeral" ||
    value === "snapshot" ||
    value === "worktree" ||
    value === "container"
  );
}

function isDelegationModelRouteSource(
  value: unknown,
): value is NonNullable<DelegationModelRouteRecord["source"]> {
  return value === "execution_shape" || value === "preset" || value === "policy";
}

function isDelegationModelRouteMode(
  value: unknown,
): value is NonNullable<DelegationModelRouteRecord["mode"]> {
  return value === "explicit" || value === "auto";
}

function readDelegationAdoptionValue(value: unknown): DelegationAdoptionRecord | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const contractId = readString(record?.contractId);
  const decision = record?.decision;
  const reason = readString(record?.reason);
  if (
    !contractId ||
    (decision !== "allow" && decision !== "block" && decision !== "require_human") ||
    !reason
  ) {
    return undefined;
  }
  const requiredEvidence = Array.isArray(record.requiredEvidence)
    ? record.requiredEvidence
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : undefined;
  return {
    contractId,
    decision,
    reason,
    ...(requiredEvidence && requiredEvidence.length > 0 ? { requiredEvidence } : {}),
  };
}

function readDelegationLineageValue(value: unknown): DelegationLineageRecord | undefined {
  const record = asRecord(value);
  const parentSessionId = readString(record?.parentSessionId);
  const contextPolicy = record?.contextPolicy;
  if (
    !parentSessionId ||
    (contextPolicy !== "lineage_only" && contextPolicy !== "working_snapshot")
  ) {
    return undefined;
  }
  return {
    parentSessionId: parentSessionId as DelegationLineageRecord["parentSessionId"],
    contextPolicy,
  };
}

function readDelegationArtifactRefValue(value: unknown): DelegationArtifactRef | null {
  const record = asRecord(value);
  const kind = readString(record?.kind);
  const path = readString(record?.path);
  if (!kind || !path) {
    return null;
  }
  return {
    kind,
    path,
    ...(readString(record?.summary) ? { summary: readString(record?.summary)! } : {}),
  };
}

function readDelegationArtifactRefsValue(value: unknown): DelegationArtifactRef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const refs = value
    .map((entry) => readDelegationArtifactRefValue(entry))
    .filter((entry): entry is DelegationArtifactRef => entry !== null);
  return refs.length > 0 ? refs : undefined;
}

function readDelegationModelRouteValue(value: unknown): DelegationModelRouteRecord | undefined {
  const record = asRecord(value);
  const selectedModel = readString(record?.selectedModel);
  const source = record?.source;
  const mode = record?.mode;
  const reason = readString(record?.reason);
  if (
    !selectedModel ||
    !isDelegationModelRouteSource(source) ||
    !isDelegationModelRouteMode(mode) ||
    !reason
  ) {
    return undefined;
  }
  return {
    selectedModel,
    source,
    mode,
    reason,
    ...(readString(record?.policyId) ? { policyId: readString(record?.policyId)! } : {}),
    ...(readString(record?.requestedModel)
      ? { requestedModel: readString(record?.requestedModel)! }
      : {}),
    ...(readString(record?.presetName) ? { presetName: readString(record?.presetName)! } : {}),
  };
}

function readDelegationKindValue(
  value: unknown,
): DelegationLifecycleEventPayload["kind"] | undefined {
  if (value === "consult" || value === "qa" || value === "patch") {
    return value;
  }
  if (value === "exploration" || value === "plan" || value === "review") {
    return "consult";
  }
  return undefined;
}

function readDelegationConsultKindValue(
  consultKind: unknown,
  rawKind: unknown,
  record: Record<string, unknown> | null,
): DelegationLifecycleEventPayload["consultKind"] | undefined {
  if (
    consultKind === "investigate" ||
    consultKind === "diagnose" ||
    consultKind === "design" ||
    consultKind === "review"
  ) {
    return consultKind;
  }
  if (rawKind === "review") {
    return "review";
  }
  if (rawKind === "plan") {
    return "design";
  }
  if (rawKind !== "exploration") {
    return undefined;
  }
  const delegatedSkill = readString(record?.skillName) ?? readString(record?.parentSkill);
  return delegatedSkill === "debugging" ? "diagnose" : "investigate";
}

function readDelegationDeliveryValue(
  record: Record<string, unknown> | null,
): DelegationDeliveryRecord | undefined {
  if (!record) {
    return undefined;
  }
  const mode = record?.deliveryMode;
  if (!isDelegationDeliveryMode(mode)) {
    return undefined;
  }
  const readyAt = readNonNegativeNumber(record.deliveryReadyAt);
  const surfacedAt = readNonNegativeNumber(record.deliverySurfacedAt);
  const updatedAt = readNonNegativeNumber(record.deliveryUpdatedAt);
  return {
    mode,
    ...(readString(record.deliveryScopeId) ? { scopeId: readString(record.deliveryScopeId)! } : {}),
    ...(readString(record.deliveryLabel) ? { label: readString(record.deliveryLabel)! } : {}),
    ...(isDelegationDeliveryHandoffState(record.deliveryHandoffState)
      ? { handoffState: record.deliveryHandoffState }
      : {}),
    ...(readyAt !== null ? { readyAt } : {}),
    ...(surfacedAt !== null ? { surfacedAt } : {}),
    ...(typeof record.supplementalAppended === "boolean"
      ? { supplementalAppended: record.supplementalAppended }
      : {}),
    ...(updatedAt !== null ? { updatedAt } : {}),
  };
}

function readDelegationLifecycleEventPayloadValue(
  payload: unknown,
  eventType:
    | typeof SUBAGENT_SPAWNED_EVENT_TYPE
    | typeof SUBAGENT_RUNNING_EVENT_TYPE
    | typeof SUBAGENT_COMPLETED_EVENT_TYPE
    | typeof SUBAGENT_FAILED_EVENT_TYPE
    | typeof SUBAGENT_CANCELLED_EVENT_TYPE
    | typeof SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE
    | typeof SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
): DelegationLifecycleEventPayload | null {
  const record = asRecord(payload);
  const runId = readString(record?.runId);
  if (!runId) {
    return null;
  }
  const resolvedStatus = isDelegationRunStatus(record?.status)
    ? record.status
    : eventType === SUBAGENT_SPAWNED_EVENT_TYPE
      ? "pending"
      : eventType === SUBAGENT_RUNNING_EVENT_TYPE
        ? "running"
        : eventType === SUBAGENT_COMPLETED_EVENT_TYPE
          ? "completed"
          : eventType === SUBAGENT_CANCELLED_EVENT_TYPE
            ? "cancelled"
            : eventType === SUBAGENT_FAILED_EVENT_TYPE
              ? "failed"
              : undefined;
  const contractVersion =
    record?.contractVersion === DELEGATION_CONTRACT_VERSION
      ? DELEGATION_CONTRACT_VERSION
      : undefined;
  const costUsd =
    typeof record?.costUsd === "number" && Number.isFinite(record.costUsd)
      ? Math.max(0, record.costUsd)
      : undefined;
  return {
    runId,
    ...(contractVersion !== undefined ? { contractVersion } : {}),
    ...(readString(record?.delegate) ? { delegate: readString(record?.delegate)! } : {}),
    ...(isDelegationExecutionPrimitive(record?.executionPrimitive)
      ? { executionPrimitive: record.executionPrimitive }
      : {}),
    ...(isDelegationVisibility(record?.visibility) ? { visibility: record.visibility } : {}),
    ...(isDelegationIsolationStrategy(record?.isolationStrategy)
      ? { isolationStrategy: record.isolationStrategy }
      : {}),
    ...(readDelegationAdoptionValue(record?.adoption)
      ? { adoption: readDelegationAdoptionValue(record?.adoption)! }
      : {}),
    ...(readDelegationLineageValue(record?.lineage)
      ? { lineage: readDelegationLineageValue(record?.lineage)! }
      : {}),
    ...(readString(record?.agentSpec) ? { agentSpec: readString(record?.agentSpec)! } : {}),
    ...(readString(record?.envelope) ? { envelope: readString(record?.envelope)! } : {}),
    ...(readString(record?.skillName) ? { skillName: readString(record?.skillName)! } : {}),
    ...(readString(record?.label) ? { label: readString(record?.label)! } : {}),
    ...(readString(record?.childSessionId)
      ? {
          childSessionId: readString(
            record?.childSessionId,
          )! as DelegationLifecycleEventPayload["childSessionId"],
        }
      : {}),
    ...(readString(record?.parentSkill) ? { parentSkill: readString(record?.parentSkill)! } : {}),
    ...(readDelegationKindValue(record?.kind)
      ? { kind: readDelegationKindValue(record?.kind)! }
      : {}),
    ...(readDelegationConsultKindValue(record?.consultKind, record?.kind, record)
      ? { consultKind: readDelegationConsultKindValue(record?.consultKind, record?.kind, record)! }
      : {}),
    ...(isToolExecutionBoundary(record?.boundary) ? { boundary: record.boundary } : {}),
    ...(resolvedStatus ? { status: resolvedStatus } : {}),
    ...(readString(record?.summary) ? { summary: readString(record?.summary)! } : {}),
    ...(readString(record?.error) ? { error: readString(record?.error)! } : {}),
    ...(readString(record?.reason) ? { reason: readString(record?.reason)! } : {}),
    ...(readJsonRecord(record?.resultData)
      ? { resultData: readJsonRecord(record?.resultData)! }
      : {}),
    ...(readDelegationArtifactRefsValue(record?.artifactRefs)
      ? { artifactRefs: readDelegationArtifactRefsValue(record?.artifactRefs)! }
      : {}),
    ...(readDelegationDeliveryValue(record)
      ? { delivery: readDelegationDeliveryValue(record)! }
      : {}),
    ...(readDelegationModelRouteValue(record?.modelRoute)
      ? { modelRoute: readDelegationModelRouteValue(record?.modelRoute)! }
      : {}),
    ...(readNonNegativeNumber(record?.totalTokens) !== null
      ? { totalTokens: readNonNegativeNumber(record?.totalTokens)! }
      : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function readWorkerResultsAppliedEventPayloadValue(
  payload: unknown,
): WorkerResultsAppliedEventPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const workerIds = new Set<string>();
  const workerId = readString(record.workerId) ?? undefined;
  if (workerId) {
    workerIds.add(workerId);
  }
  if (Array.isArray(record.workerIds)) {
    for (const value of record.workerIds) {
      const normalized = readString(value);
      if (normalized) {
        workerIds.add(normalized);
      }
    }
  }
  if (workerIds.size === 0) {
    return null;
  }
  const appliedPaths = Array.isArray(record.appliedPaths)
    ? record.appliedPaths
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : undefined;
  return {
    workerIds: [...workerIds],
    ...(workerId ? { workerId } : {}),
    ...(readString(record.patchSetId) ? { patchSetId: readString(record.patchSetId)! } : {}),
    ...(appliedPaths && appliedPaths.length > 0 ? { appliedPaths } : {}),
  };
}

export const SUBAGENT_SPAWNED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SUBAGENT_SPAWNED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload(payload): DelegationLifecycleEventPayload | null {
    return readDelegationLifecycleEventPayloadValue(payload, SUBAGENT_SPAWNED_EVENT_TYPE);
  },
});

export const SUBAGENT_RUNNING_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SUBAGENT_RUNNING_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload(payload): DelegationLifecycleEventPayload | null {
    return readDelegationLifecycleEventPayloadValue(payload, SUBAGENT_RUNNING_EVENT_TYPE);
  },
});

export const SUBAGENT_COMPLETED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SUBAGENT_COMPLETED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload(payload): DelegationLifecycleEventPayload | null {
    return readDelegationLifecycleEventPayloadValue(payload, SUBAGENT_COMPLETED_EVENT_TYPE);
  },
});

export const SUBAGENT_FAILED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SUBAGENT_FAILED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload(payload): DelegationLifecycleEventPayload | null {
    return readDelegationLifecycleEventPayloadValue(payload, SUBAGENT_FAILED_EVENT_TYPE);
  },
});

export const SUBAGENT_CANCELLED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SUBAGENT_CANCELLED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload(payload): DelegationLifecycleEventPayload | null {
    return readDelegationLifecycleEventPayloadValue(payload, SUBAGENT_CANCELLED_EVENT_TYPE);
  },
});

export const SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload(payload): DelegationLifecycleEventPayload | null {
    return readDelegationLifecycleEventPayloadValue(
      payload,
      SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
    );
  },
});

export const SUBAGENT_DELIVERY_SURFACED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload(payload): DelegationLifecycleEventPayload | null {
    return readDelegationLifecycleEventPayloadValue(payload, SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE);
  },
});

export const WORKER_RESULTS_APPLIED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: WORKER_RESULTS_APPLIED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload: readWorkerResultsAppliedEventPayloadValue,
});

export const DELEGATION_EVENT_DESCRIPTORS = [
  SUBAGENT_SPAWNED_EVENT_DESCRIPTOR,
  SUBAGENT_RUNNING_EVENT_DESCRIPTOR,
  SUBAGENT_COMPLETED_EVENT_DESCRIPTOR,
  SUBAGENT_FAILED_EVENT_DESCRIPTOR,
  SUBAGENT_CANCELLED_EVENT_DESCRIPTOR,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_DESCRIPTOR,
  SUBAGENT_DELIVERY_SURFACED_EVENT_DESCRIPTOR,
  WORKER_RESULTS_APPLIED_EVENT_DESCRIPTOR,
] as const;

export const DELEGATION_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
] as const;

export function readDelegationLifecycleEventPayload(
  event: BrewvaEventLike,
): DelegationLifecycleEventPayload | null {
  switch (event.type) {
    case SUBAGENT_SPAWNED_EVENT_TYPE:
      return readBrewvaEventPayload(event, SUBAGENT_SPAWNED_EVENT_DESCRIPTOR);
    case SUBAGENT_RUNNING_EVENT_TYPE:
      return readBrewvaEventPayload(event, SUBAGENT_RUNNING_EVENT_DESCRIPTOR);
    case SUBAGENT_COMPLETED_EVENT_TYPE:
      return readBrewvaEventPayload(event, SUBAGENT_COMPLETED_EVENT_DESCRIPTOR);
    case SUBAGENT_FAILED_EVENT_TYPE:
      return readBrewvaEventPayload(event, SUBAGENT_FAILED_EVENT_DESCRIPTOR);
    case SUBAGENT_CANCELLED_EVENT_TYPE:
      return readBrewvaEventPayload(event, SUBAGENT_CANCELLED_EVENT_DESCRIPTOR);
    case SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE:
      return readBrewvaEventPayload(event, SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_DESCRIPTOR);
    case SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE:
      return readBrewvaEventPayload(event, SUBAGENT_DELIVERY_SURFACED_EVENT_DESCRIPTOR);
    default:
      return null;
  }
}

export function readWorkerResultsAppliedEventPayload(
  event: BrewvaEventLike,
): WorkerResultsAppliedEventPayload | null {
  return readBrewvaEventPayload(event, WORKER_RESULTS_APPLIED_EVENT_DESCRIPTOR);
}
