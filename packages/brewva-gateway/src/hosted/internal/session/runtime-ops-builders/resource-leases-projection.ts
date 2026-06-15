import type { ResourceLeaseRecord } from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";

function isResourceLease(value: unknown): value is ResourceLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.status === "string";
}

/**
 * Rebuild resource leases from durable `resource_lease_*` tape events. The
 * in-process Map is a droppable cache over this projection: after a restart it
 * starts empty and is rehydrated here, so active/cancelled leases recorded by a
 * prior process survive.
 */
function projectResourceLeasesFromTape(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): ResourceLeaseRecord[] {
  const order: string[] = [];
  const byId = new Map<string, ResourceLeaseRecord>();
  for (const event of ctx.listEvents(sessionId)) {
    if (event.type !== "resource_lease_requested" && event.type !== "resource_lease_cancelled") {
      continue;
    }
    const payload = event.payload;
    const lease =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { lease?: unknown }).lease
        : undefined;
    if (!isResourceLease(lease)) {
      continue;
    }
    if (!byId.has(lease.id)) {
      order.push(lease.id);
    }
    byId.set(lease.id, lease);
  }
  return order.flatMap((id) => {
    const lease = byId.get(id);
    return lease ? [lease] : [];
  });
}

export function resourceLeasesFor(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): ResourceLeaseRecord[] {
  const cached = ctx.state.resourceLeases.get(sessionId);
  if (cached !== undefined) {
    return cached;
  }
  const rebuilt = projectResourceLeasesFromTape(ctx, sessionId);
  ctx.state.resourceLeases.set(sessionId, rebuilt);
  return rebuilt;
}
