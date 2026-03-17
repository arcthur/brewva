import {
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
} from "../events/event-types.js";
import type { ResourceLeaseBudget, ResourceLeaseRecord } from "../types.js";
import type {
  ResourceLeaseHydrationState,
  SessionHydrationFold,
} from "./session-hydration-fold.js";
import { readEventPayload, readNonNegativeNumber } from "./session-hydration-fold.js";

function readLeaseBudget(value: unknown): ResourceLeaseBudget {
  const payload =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  return {
    maxToolCalls: readNonNegativeNumber(payload?.maxToolCalls) ?? undefined,
    maxTokens: readNonNegativeNumber(payload?.maxTokens) ?? undefined,
    maxParallel: readNonNegativeNumber(payload?.maxParallel) ?? undefined,
  };
}

function readLeaseRecord(payload: Record<string, unknown> | null): ResourceLeaseRecord | undefined {
  const leaseId = typeof payload?.id === "string" ? payload.id.trim() : "";
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
  const skillName = typeof payload?.skillName === "string" ? payload.skillName.trim() : "";
  const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
  const createdAt = readNonNegativeNumber(payload?.createdAt);
  const status =
    payload?.status === "active" || payload?.status === "cancelled" || payload?.status === "expired"
      ? payload.status
      : null;
  if (!leaseId || !sessionId || !skillName || !reason || createdAt === null || !status) {
    return undefined;
  }
  return {
    id: leaseId,
    sessionId,
    skillName,
    reason,
    budget: readLeaseBudget(payload?.budget),
    createdAt,
    expiresAt: readNonNegativeNumber(payload?.expiresAt) ?? undefined,
    expiresAfterTurn: readNonNegativeNumber(payload?.expiresAfterTurn) ?? undefined,
    status,
  };
}

function readLeaseStatus(payload: Record<string, unknown> | null): {
  leaseId: string;
  status: ResourceLeaseRecord["status"];
  cancelledAt?: number;
  cancelledReason?: string;
} | null {
  const leaseId = typeof payload?.leaseId === "string" ? payload.leaseId.trim() : "";
  const status =
    payload?.status === "active" || payload?.status === "cancelled" || payload?.status === "expired"
      ? payload.status
      : null;
  if (!leaseId || !status) {
    return null;
  }
  return {
    leaseId,
    status,
    cancelledAt: readNonNegativeNumber(payload?.cancelledAt) ?? undefined,
    cancelledReason:
      typeof payload?.cancelledReason === "string" && payload.cancelledReason.trim().length > 0
        ? payload.cancelledReason.trim()
        : undefined,
  };
}

export function createResourceLeaseHydrationFold(): SessionHydrationFold<ResourceLeaseHydrationState> {
  return {
    domain: "resource-lease",
    initial() {
      return {
        resourceLeases: new Map<string, ResourceLeaseRecord>(),
      };
    },
    fold(state, event) {
      const payload = readEventPayload(event);

      if (event.type === RESOURCE_LEASE_GRANTED_EVENT_TYPE) {
        const lease = readLeaseRecord(payload);
        if (lease) {
          state.resourceLeases.set(lease.id, lease);
        }
        return;
      }

      if (
        event.type === RESOURCE_LEASE_CANCELLED_EVENT_TYPE ||
        event.type === RESOURCE_LEASE_EXPIRED_EVENT_TYPE
      ) {
        const nextStatus = readLeaseStatus(payload);
        if (!nextStatus) {
          return;
        }
        const lease = state.resourceLeases.get(nextStatus.leaseId);
        if (!lease) {
          return;
        }
        lease.status = nextStatus.status;
        if (nextStatus.status === "cancelled") {
          lease.cancelledAt = nextStatus.cancelledAt;
          lease.cancelledReason = nextStatus.cancelledReason;
        }
      }
    },
    apply(state, cell) {
      cell.resourceLeases = state.resourceLeases;
    },
  };
}
