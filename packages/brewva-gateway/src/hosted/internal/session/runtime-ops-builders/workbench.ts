import { randomUUID } from "node:crypto";
import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

const WORKBENCH_ENTRY_EVENT_TYPES = new Set([
  "workbench.note.recorded",
  "workbench.eviction.recorded",
]);

function isWorkbenchEntry(value: unknown): value is WorkbenchEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.kind === "string" &&
    typeof record.createdAt === "number"
  );
}

/**
 * Rebuild the workbench entry list from durable `workbench.*` tape events. The
 * in-process Map is a droppable cache over this projection, not a second source
 * of truth: after a restart the Map starts empty and is rehydrated here on first
 * access. Tape order is append order, which is the entry order we want.
 */
function projectWorkbenchEntriesFromTape(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): WorkbenchEntry[] {
  return ctx
    .listEvents(sessionId)
    .filter((event) => WORKBENCH_ENTRY_EVENT_TYPES.has(event.type))
    .map((event) => event.payload)
    .filter(isWorkbenchEntry);
}

function workbenchEntriesFor(ctx: HostedRuntimeOpsContext, sessionId: string): WorkbenchEntry[] {
  const cached = ctx.state.workbenchEntries.get(sessionId);
  if (cached !== undefined) {
    return cached;
  }
  const rebuilt = projectWorkbenchEntriesFromTape(ctx, sessionId);
  ctx.state.workbenchEntries.set(sessionId, rebuilt);
  return rebuilt;
}

export function buildWorkbenchRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["workbench"] {
  return {
    commitBaseline: (sessionId) => workbenchEntriesFor(ctx, sessionId),
    list: (sessionId) => workbenchEntriesFor(ctx, sessionId),
    note(sessionId, input) {
      const entry: WorkbenchEntry = {
        id: randomUUID(),
        kind: "note",
        digest: `workbench.note:${Date.now()}:${input.content.length}`,
        content: input.content,
        sourceRefs: [...(input.sourceRefs ?? [])],
        reason: input.reason,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      ctx.state.workbenchEntries.set(sessionId, [...workbenchEntriesFor(ctx, sessionId), entry]);
      ctx.emit(sessionId, "workbench.note.recorded", entry);
      return entry;
    },
    evict(sessionId, input) {
      const entry: WorkbenchEntry = {
        id: randomUUID(),
        kind: "eviction",
        digest: `workbench.eviction:${Date.now()}:${input.spanRefs.join(",")}`,
        content: input.replacementNote,
        preservedQuotes: input.preservedQuotes,
        sourceRefs: [...input.spanRefs],
        reason: input.reason,
        reversible: true,
        ...(input.rcr && input.rcr.length > 0 ? { rcr: input.rcr } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      ctx.state.workbenchEntries.set(sessionId, [...workbenchEntriesFor(ctx, sessionId), entry]);
      ctx.emit(sessionId, "workbench.eviction.recorded", entry);
      return entry;
    },
    undoEviction(sessionId, entryId, reason) {
      const entry = workbenchEntriesFor(ctx, sessionId).find((item) => item.id === entryId);
      ctx.emit(sessionId, "workbench.eviction.undone", { entryId, reason, undone: Boolean(entry) });
      return entry ? { undone: true, entry } : { undone: false };
    },
  };
}
