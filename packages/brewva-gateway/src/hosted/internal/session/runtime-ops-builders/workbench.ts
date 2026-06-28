import { randomUUID } from "node:crypto";
import {
  buildUserFactEntry,
  USER_FACT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/user-model";
import {
  type WorkbenchEntry,
  WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
  WORKBENCH_EVICTION_UNDONE_EVENT_TYPE,
  WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildWorkbenchRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["workbench"] {
  const { workbench } = ctx.projections;
  return {
    commitBaseline: (sessionId) => workbench(sessionId),
    list: (sessionId) => workbench(sessionId),
    note(sessionId, input) {
      const entry: WorkbenchEntry = {
        id: randomUUID(),
        kind: "note",
        digest: `workbench.note:${Date.now()}:${input.content.length}`,
        content: input.content,
        sourceRefs: [...(input.sourceRefs ?? [])],
        reason: input.reason,
        ...(input.retentionHint ? { retentionHint: input.retentionHint } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      ctx.emit(sessionId, WORKBENCH_NOTE_RECORDED_EVENT_TYPE, entry);
      return entry;
    },
    recordUserFact(sessionId, input) {
      const entry = buildUserFactEntry(input, { id: randomUUID(), createdAt: Date.now() });
      ctx.emit(sessionId, USER_FACT_RECORDED_EVENT_TYPE, entry);
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
      ctx.emit(sessionId, WORKBENCH_EVICTION_RECORDED_EVENT_TYPE, entry);
      return entry;
    },
    undoEviction(sessionId, entryId, reason) {
      const entry = workbench(sessionId).find((item) => item.id === entryId);
      ctx.emit(sessionId, WORKBENCH_EVICTION_UNDONE_EVENT_TYPE, {
        entryId,
        reason,
        undone: Boolean(entry),
      });
      return entry ? { undone: true, entry } : { undone: false };
    },
  };
}
