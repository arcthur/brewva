import { randomUUID } from "node:crypto";
import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildWorkbenchRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["workbench"] {
  return {
    commitBaseline: (sessionId) => ctx.state.workbenchEntries.get(sessionId) ?? [],
    list: (sessionId) => ctx.state.workbenchEntries.get(sessionId) ?? [],
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
      ctx.state.workbenchEntries.set(sessionId, [
        ...(ctx.state.workbenchEntries.get(sessionId) ?? []),
        entry,
      ]);
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      ctx.state.workbenchEntries.set(sessionId, [
        ...(ctx.state.workbenchEntries.get(sessionId) ?? []),
        entry,
      ]);
      ctx.emit(sessionId, "workbench.eviction.recorded", entry);
      return entry;
    },
    undoEviction(sessionId, entryId, reason) {
      const entry = (ctx.state.workbenchEntries.get(sessionId) ?? []).find(
        (item) => item.id === entryId,
      );
      ctx.emit(sessionId, "workbench.eviction.undone", { entryId, reason, undone: Boolean(entry) });
      return entry ? { undone: true, entry } : { undone: false };
    },
  };
}
