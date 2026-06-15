import { isRecord } from "@brewva/brewva-std/unknown";
import type { WorkerResult } from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventQuery, ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { ResourceLeaseRecord } from "@brewva/brewva-vocabulary/iteration";
import type { TaskItem, TaskSpec } from "@brewva/brewva-vocabulary/task";
import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
import type { RuntimeEventRecord } from "../runtime-ops-port.js";

/**
 * Pure, tape-authoritative read projections for the durable hosted-state domains
 * (task spec/items/blockers, resource leases, workbench, worker results).
 *
 *     command -> emit event ;  query / decision -> pure projector -> tape
 *
 * There is deliberately NO cache. Every read replays the session's tape, so a
 * projection can never disagree with durable truth: no stale warm read when the
 * tape gains events out of band, no mutable cache reference to leak (each read
 * returns a fresh array), and no cache-ahead-of-tape window if an emit is
 * rejected. The tape is in-memory (`eventsBySession`), so replay-per-read is a
 * cheap array scan — the same scan the parallel-admission gate already performs.
 * Mutations live in the builders and only emit events; projections never mutate.
 */

type ListEvents = (sessionId: string, query?: BrewvaEventQuery) => RuntimeEventRecord[];

export interface HostedProjections {
  readonly taskSpec: (sessionId: string) => TaskSpec | undefined;
  readonly taskItems: (sessionId: string) => TaskItem[];
  readonly taskBlockers: (sessionId: string) => ProtocolRecord[];
  readonly resourceLeases: (sessionId: string) => ResourceLeaseRecord[];
  readonly workbench: (sessionId: string) => WorkbenchEntry[];
  readonly workerResults: (sessionId: string) => WorkerResult[];
}

export function readStringArrayRecord(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || !(key in value)) {
    return [];
  }
  const item = (value as Record<string, unknown>)[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isTaskItem(value: unknown): value is TaskItem {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string" && typeof value.text === "string";
}

function projectTaskItems(listEvents: ListEvents, sessionId: string): TaskItem[] {
  const order: string[] = [];
  const byId = new Map<string, TaskItem>();
  for (const event of listEvents(sessionId)) {
    if (event.type === "task.item.added") {
      if (isTaskItem(event.payload)) {
        const item = event.payload;
        if (!byId.has(item.id)) {
          order.push(item.id);
        }
        byId.set(item.id, { id: item.id, text: item.text, status: item.status });
      }
      continue;
    }
    if (event.type === "task.item.updated") {
      if (!isRecord(event.payload)) {
        continue;
      }
      const record = event.payload;
      const id = typeof record.id === "string" ? record.id : undefined;
      const existing = id ? byId.get(id) : undefined;
      if (id && existing) {
        byId.set(id, {
          id,
          text: typeof record.text === "string" ? record.text : existing.text,
          status: (record.status as TaskItem["status"] | undefined) ?? existing.status,
        });
      }
    }
  }
  return order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

function projectTaskBlockers(listEvents: ListEvents, sessionId: string): ProtocolRecord[] {
  let blockers: ProtocolRecord[] = [];
  for (const event of listEvents(sessionId)) {
    if (event.type === "task.blocker.recorded") {
      if (isRecord(event.payload)) {
        blockers.push(event.payload);
      }
      continue;
    }
    if (event.type === "task.blocker.resolved") {
      const blockerId = isRecord(event.payload) ? event.payload.blockerId : undefined;
      if (typeof blockerId === "string") {
        blockers = blockers.filter((entry) => entry.id !== blockerId);
      }
    }
  }
  return blockers;
}

function projectTaskSpec(listEvents: ListEvents, sessionId: string): TaskSpec | undefined {
  const event = listEvents(sessionId, { type: "task.spec.set", last: 1 })[0];
  const spec = isRecord(event?.payload) ? event.payload.spec : undefined;
  return isRecord(spec) ? (spec as TaskSpec) : undefined;
}

function isResourceLease(value: unknown): value is ResourceLeaseRecord {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string" && typeof value.status === "string";
}

function projectResourceLeases(listEvents: ListEvents, sessionId: string): ResourceLeaseRecord[] {
  const order: string[] = [];
  const byId = new Map<string, ResourceLeaseRecord>();
  for (const event of listEvents(sessionId)) {
    if (event.type !== "resource_lease_requested" && event.type !== "resource_lease_cancelled") {
      continue;
    }
    const lease = isRecord(event.payload)
      ? (event.payload as { lease?: unknown }).lease
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

const WORKBENCH_ENTRY_EVENT_TYPES = new Set([
  "workbench.note.recorded",
  "workbench.eviction.recorded",
]);

function isWorkbenchEntry(value: unknown): value is WorkbenchEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.createdAt === "number"
  );
}

function projectWorkbench(listEvents: ListEvents, sessionId: string): WorkbenchEntry[] {
  return listEvents(sessionId)
    .filter((event) => WORKBENCH_ENTRY_EVENT_TYPES.has(event.type))
    .map((event) => event.payload)
    .filter(isWorkbenchEntry);
}

function projectWorkerResults(listEvents: ListEvents, sessionId: string): WorkerResult[] {
  let results: WorkerResult[] = [];
  for (const event of listEvents(sessionId)) {
    if (event.type === "worker.result.recorded") {
      const value = isRecord(event.payload)
        ? (event.payload as { value?: unknown }).value
        : undefined;
      if (value !== undefined) {
        results.push(value as WorkerResult);
      }
      continue;
    }
    if (event.type === "worker.results.cleared") {
      const selected = new Set(readStringArrayRecord(event.payload, "workerIds"));
      results =
        selected.size === 0
          ? []
          : results.filter((result, index) => {
              const record = isRecord(result) ? result : {};
              const workerId =
                typeof record.workerId === "string" ? record.workerId : `worker_${index + 1}`;
              return !selected.has(workerId);
            });
    }
  }
  return results;
}

export function createHostedProjections(deps: {
  readonly listEvents: ListEvents;
}): HostedProjections {
  const { listEvents } = deps;
  return {
    taskSpec: (sessionId) => projectTaskSpec(listEvents, sessionId),
    taskItems: (sessionId) => projectTaskItems(listEvents, sessionId),
    taskBlockers: (sessionId) => projectTaskBlockers(listEvents, sessionId),
    resourceLeases: (sessionId) => projectResourceLeases(listEvents, sessionId),
    workbench: (sessionId) => projectWorkbench(listEvents, sessionId),
    workerResults: (sessionId) => projectWorkerResults(listEvents, sessionId),
  };
}
