import type { TapeForensicScan } from "@brewva/brewva-runtime";
import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  RuntimeSessionHydration,
  RuntimeSessionIntegrity,
  RuntimeSessionIssue,
} from "@brewva/brewva-tools/contracts";
import {
  WORKER_RESULT_RECORDED_EVENT_TYPE,
  type WorkerResult,
} from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventQuery, ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { ResourceLeaseRecord } from "@brewva/brewva-vocabulary/iteration";
import {
  foldTaskLedgerEvents,
  TASK_BLOCKER_RECORDED_EVENT_TYPE,
  TASK_BLOCKER_RESOLVED_EVENT_TYPE,
  TASK_ITEM_ADDED_EVENT_TYPE,
  TASK_ITEM_UPDATED_EVENT_TYPE,
  TASK_SPEC_SET_EVENT_TYPE,
  type RequirementAtom,
  type TaskItem,
  type TaskSpec,
} from "@brewva/brewva-vocabulary/task";
import {
  type WorkbenchEntry,
  WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
  WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
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
type ScanTape = (sessionId: string) => TapeForensicScan;

export interface HostedProjections {
  readonly taskSpec: (sessionId: string) => TaskSpec | undefined;
  readonly taskItems: (sessionId: string) => TaskItem[];
  readonly taskBlockers: (sessionId: string) => ProtocolRecord[];
  readonly taskRequirements: (sessionId: string) => readonly RequirementAtom[];
  readonly resourceLeases: (sessionId: string) => ResourceLeaseRecord[];
  readonly workbench: (sessionId: string) => WorkbenchEntry[];
  readonly workerResults: (sessionId: string) => WorkerResult[];
  readonly hydration: (sessionId: string) => RuntimeSessionHydration;
  readonly integrity: (sessionId: string) => RuntimeSessionIntegrity;
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
    if (event.type === TASK_ITEM_ADDED_EVENT_TYPE) {
      if (isTaskItem(event.payload)) {
        const item = event.payload;
        if (!byId.has(item.id)) {
          order.push(item.id);
        }
        byId.set(item.id, { id: item.id, text: item.text, status: item.status });
      }
      continue;
    }
    if (event.type === TASK_ITEM_UPDATED_EVENT_TYPE) {
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
    if (event.type === TASK_BLOCKER_RECORDED_EVENT_TYPE) {
      if (isRecord(event.payload)) {
        blockers.push(event.payload);
      }
      continue;
    }
    if (event.type === TASK_BLOCKER_RESOLVED_EVENT_TYPE) {
      const blockerId = isRecord(event.payload) ? event.payload.blockerId : undefined;
      if (typeof blockerId === "string") {
        blockers = blockers.filter((entry) => entry.id !== blockerId);
      }
    }
  }
  return blockers;
}

function projectTaskSpec(listEvents: ListEvents, sessionId: string): TaskSpec | undefined {
  const event = listEvents(sessionId, { type: TASK_SPEC_SET_EVENT_TYPE, last: 1 })[0];
  const spec = isRecord(event?.payload) ? event.payload.spec : undefined;
  return isRecord(spec) ? (spec as TaskSpec) : undefined;
}

// Reuses foldTaskLedgerEvents (the same fold task_set_spec's amend-vs-mint
// decision reads through) rather than re-deriving requirement-atom reduction
// here: one fold, two callers.
function projectTaskRequirements(
  listEvents: ListEvents,
  sessionId: string,
): readonly RequirementAtom[] {
  return foldTaskLedgerEvents(listEvents(sessionId)).requirements;
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

const WORKBENCH_ENTRY_EVENT_TYPES = new Set<string>([
  WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
  WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
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
    if (event.type === WORKER_RESULT_RECORDED_EVENT_TYPE) {
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

function tapeForensicIssues(scan: TapeForensicScan): RuntimeSessionIssue[] {
  return scan.issues.map((issue) => ({
    domain: "event_tape" as const,
    severity: "error" as const,
    index: issue.line,
    reason: `${issue.issueClass} at line ${issue.line} (byte ${issue.byteOffset}); ${
      issue.tailLocal ? (scan.tornTail ? "torn tail" : "tail record") : "precedes later records"
    }`,
  }));
}

function projectHydration(
  listEvents: ListEvents,
  scanTape: ScanTape,
  clock: () => number,
  sessionId: string,
): RuntimeSessionHydration {
  const scan = scanTape(sessionId);
  const hydratedAt = clock();
  if (scan.issues.length > 0) {
    // Damage found by the forensic scan: degrade with explicit event_tape issues
    // instead of letting the strict reader collapse the session. Read the cursor
    // from the scan's valid prefix — never call listEvents, which would throw.
    return {
      status: "degraded",
      hydratedAt,
      cursor: { latestEventId: scan.lastValidEventId, eventCount: scan.validRecords },
      reason: null,
      issues: tapeForensicIssues(scan),
    };
  }
  // The shared grammar guarantees a clean forensic scan implies the strict reader
  // will not throw, so listEvents is safe here and reflects the actually rebuilt
  // state (including in-memory sessions that have no tape file to scan).
  const events = listEvents(sessionId);
  const cursor = { latestEventId: events.at(-1)?.id ?? null, eventCount: events.length };
  return events.length === 0
    ? { status: "cold", hydratedAt, cursor, reason: null, issues: [] }
    : { status: "ready", hydratedAt, cursor, reason: null, issues: [] };
}

function projectIntegrity(scanTape: ScanTape, sessionId: string): RuntimeSessionIntegrity {
  const scan = scanTape(sessionId);
  if (scan.issues.length > 0) {
    return {
      status: "degraded",
      cursor: { latestEventId: scan.lastValidEventId, eventCount: scan.validRecords },
      reason: null,
      issues: tapeForensicIssues(scan),
    };
  }
  // Tape verified clean. WAL, artifact, and ledger dimensions are not yet checked,
  // so we must not claim full health — stay honestly inconclusive.
  return {
    status: "inconclusive",
    cursor: null,
    reason:
      "tape integrity verified; WAL, artifact, and ledger checks not yet implemented (RFC WS1)",
    issues: [],
  };
}

export function createHostedProjections(deps: {
  readonly listEvents: ListEvents;
  readonly scanTape: ScanTape;
  readonly clock: () => number;
}): HostedProjections {
  const { listEvents, scanTape, clock } = deps;
  return {
    taskSpec: (sessionId) => projectTaskSpec(listEvents, sessionId),
    taskItems: (sessionId) => projectTaskItems(listEvents, sessionId),
    taskBlockers: (sessionId) => projectTaskBlockers(listEvents, sessionId),
    taskRequirements: (sessionId) => projectTaskRequirements(listEvents, sessionId),
    resourceLeases: (sessionId) => projectResourceLeases(listEvents, sessionId),
    workbench: (sessionId) => projectWorkbench(listEvents, sessionId),
    workerResults: (sessionId) => projectWorkerResults(listEvents, sessionId),
    hydration: (sessionId) => projectHydration(listEvents, scanTape, clock, sessionId),
    integrity: (sessionId) => projectIntegrity(scanTape, sessionId),
  };
}
