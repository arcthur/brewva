import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { TaskItem, TaskSpec } from "@brewva/brewva-vocabulary/task";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";

// Tape-authoritative read projections for the task builder, extracted from
// task.ts so the builder stays under the per-builder compression budget. The
// in-process Maps are droppable caches over these projections; after a restart
// they start empty and are rehydrated here from durable `task.*` tape events.

function isTaskItem(value: unknown): value is TaskItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.text === "string";
}

/**
 * Rebuild task items from durable `task.item.*` tape events. The in-process Map
 * is a droppable cache over this projection: after a restart it starts empty and
 * is rehydrated here, so items recorded by a prior process survive.
 */
function projectTaskItemsFromTape(ctx: HostedRuntimeOpsContext, sessionId: string): TaskItem[] {
  const order: string[] = [];
  const byId = new Map<string, TaskItem>();
  for (const event of ctx.listEvents(sessionId)) {
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
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      const record = payload as Record<string, unknown>;
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

export function taskItemsFor(ctx: HostedRuntimeOpsContext, sessionId: string): TaskItem[] {
  const cached = ctx.state.taskItems.get(sessionId);
  if (cached !== undefined) {
    return cached;
  }
  const rebuilt = projectTaskItemsFromTape(ctx, sessionId);
  ctx.state.taskItems.set(sessionId, rebuilt);
  return rebuilt;
}

function latestPayload(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  type: string,
): ProtocolRecord | undefined {
  const event = ctx.listEvents(sessionId, { type, last: 1 })[0];
  const payload = event?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
}

export function taskSpecFor(ctx: HostedRuntimeOpsContext, sessionId: string): TaskSpec | undefined {
  const latestSpec = latestPayload(ctx, sessionId, "task.spec.set")?.spec;
  if (latestSpec && typeof latestSpec === "object" && !Array.isArray(latestSpec)) {
    return latestSpec as TaskSpec;
  }
  return ctx.state.taskSpecs.get(sessionId);
}

function normalizeTaskBlocker(value: unknown): { message: string; source?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) {
    return undefined;
  }
  const source = typeof record.source === "string" ? record.source : undefined;
  return source ? { message, source } : { message };
}

/**
 * Rebuild the live task-blocker records from durable
 * `task.blocker.{recorded,resolved}` tape events by replaying the same
 * append/remove-by-id semantics the live builder applies (record = push,
 * resolve = drop every entry with that id). Folding `resolved` is what makes the
 * projection authoritative: a resolved blocker must not reappear after a cache
 * miss or process restart. The in-process Map is a droppable cache used only
 * when the tape carries no blocker events yet.
 *
 * This is the single tape-authoritative source for the blocker domain — both the
 * read facade (`taskBlockersFor`) and the builder's record/resolve mutations
 * derive from it, so `resolve()` never disagrees with the tape after a restart.
 */
export function liveTaskBlockerRecords(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): ProtocolRecord[] {
  let blockers: ProtocolRecord[] = [];
  let hasEvents = false;
  for (const event of ctx.listEvents(sessionId)) {
    if (event.type === "task.blocker.recorded") {
      hasEvents = true;
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      blockers.push(payload);
      continue;
    }
    if (event.type === "task.blocker.resolved") {
      hasEvents = true;
      const payload = event.payload;
      const blockerId =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).blockerId
          : undefined;
      if (typeof blockerId === "string") {
        blockers = blockers.filter((entry) => entry.id !== blockerId);
      }
    }
  }
  return hasEvents ? blockers : (ctx.state.taskBlockers.get(sessionId) ?? []);
}

export function taskBlockersFor(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): { message: string; source?: string }[] {
  return liveTaskBlockerRecords(ctx, sessionId)
    .map(normalizeTaskBlocker)
    .filter((value): value is { message: string; source?: string } => value !== undefined);
}
