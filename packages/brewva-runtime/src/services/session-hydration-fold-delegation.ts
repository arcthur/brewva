import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
} from "../events/event-types.js";
import type {
  DelegationArtifactRef,
  DelegationDeliveryRecord,
  DelegationRunRecord,
  DelegationRunStatus,
  ToolExecutionBoundary,
} from "../types.js";
import type { DelegationHydrationState, SessionHydrationFold } from "./session-hydration-fold.js";
import { readEventPayload, readNonNegativeNumber } from "./session-hydration-fold.js";

function cloneArtifactRef(ref: DelegationArtifactRef): DelegationArtifactRef {
  return {
    kind: ref.kind,
    path: ref.path,
    summary: ref.summary,
  };
}

function cloneRunRecord(record: DelegationRunRecord): DelegationRunRecord {
  return {
    ...record,
    artifactRefs: record.artifactRefs?.map((ref) => cloneArtifactRef(ref)),
    delivery: record.delivery
      ? {
          mode: record.delivery.mode,
          scopeId: record.delivery.scopeId,
          label: record.delivery.label,
          supplementalAppended: record.delivery.supplementalAppended,
          updatedAt: record.delivery.updatedAt,
        }
      : undefined,
  };
}

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

function readBoundary(value: unknown): ToolExecutionBoundary | undefined {
  return value === "safe" || value === "effectful" ? value : undefined;
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
    supplementalAppended,
    updatedAt: updatedAt ?? existing?.updatedAt,
  };
}

function upsertRun(
  state: DelegationHydrationState,
  record: DelegationRunRecord,
): DelegationRunRecord {
  const cloned = cloneRunRecord(record);
  state.delegationRuns.set(cloned.runId, cloned);
  return cloned;
}

export function createDelegationHydrationFold(): SessionHydrationFold<DelegationHydrationState> {
  return {
    domain: "delegation",
    initial(cell) {
      return {
        delegationRuns: new Map(
          [...cell.delegationRuns.entries()].map(([runId, record]) => [
            runId,
            cloneRunRecord(record),
          ]),
        ),
      };
    },
    fold(state, event) {
      const payload = readEventPayload(event);
      if (event.type === SUBAGENT_SPAWNED_EVENT_TYPE) {
        const runId = readString(payload?.runId);
        const profile = readString(payload?.profile);
        if (!runId || !profile) {
          return;
        }
        const existing = state.delegationRuns.get(runId);
        upsertRun(state, {
          runId,
          profile,
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
        const existing = state.delegationRuns.get(runId);
        upsertRun(state, {
          runId,
          profile: readString(payload?.profile) ?? existing?.profile ?? "unknown",
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

      if (
        event.type === SUBAGENT_FAILED_EVENT_TYPE ||
        event.type === SUBAGENT_CANCELLED_EVENT_TYPE
      ) {
        const runId = readString(payload?.runId);
        if (!runId) {
          return;
        }
        const existing = state.delegationRuns.get(runId);
        const statusFromPayload = readRunStatus(payload?.status);
        const fallbackError =
          statusFromPayload === "timeout"
            ? "timeout"
            : event.type === SUBAGENT_CANCELLED_EVENT_TYPE
              ? "cancelled"
              : "failed";
        upsertRun(state, {
          runId,
          profile: readString(payload?.profile) ?? existing?.profile ?? "unknown",
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
        const existing = state.delegationRuns.get(runId);
        if (!existing) {
          continue;
        }
        upsertRun(state, {
          ...existing,
          status: "merged",
          updatedAt: event.timestamp,
        });
      }
    },
    apply(state, cell) {
      cell.delegationRuns = new Map(
        [...state.delegationRuns.entries()].map(([runId, record]) => [
          runId,
          cloneRunRecord(record),
        ]),
      );
    },
  };
}
