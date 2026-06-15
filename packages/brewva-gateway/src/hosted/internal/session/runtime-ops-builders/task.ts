import type { TaskItem } from "@brewva/brewva-vocabulary/task";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";
import {
  liveTaskBlockerRecords,
  taskBlockersFor,
  taskItemsFor,
  taskSpecFor,
} from "./task-projection.js";

export function buildTaskRuntimeOps(ctx: HostedRuntimeOpsContext): HostedRuntimeOpsPort["task"] {
  return {
    spec: {
      set(sessionId, spec): void {
        ctx.state.taskSpecs.set(sessionId, spec);
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.spec.set", { spec });
      },
    },
    state: {
      get(sessionId) {
        const spec = taskSpecFor(ctx, sessionId);
        return {
          ...(spec ? { spec } : {}),
          status: { phase: "active" },
          acceptance: { status: "pending" },
          items: taskItemsFor(ctx, sessionId),
          blockers: taskBlockersFor(ctx, sessionId),
          updatedAt: null,
        };
      },
    },
    items: {
      add(sessionId, item) {
        const taskItem: TaskItem = {
          id: item.id ?? `task-item:${sessionId}:${Date.now()}`,
          text: item.text,
          status: item.status,
        };
        ctx.state.taskItems.set(sessionId, [...taskItemsFor(ctx, sessionId), taskItem]);
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.item.added", taskItem, {
          timestamp: item.timestamp,
          turn: item.turn,
        });
        return { ok: true, itemId: taskItem.id, item: taskItem };
      },
      update(sessionId, item) {
        const itemId = item.id;
        const items = taskItemsFor(ctx, sessionId);
        let updated: TaskItem | undefined;
        const next = items.map((entry) => {
          if (entry.id !== itemId) {
            return entry;
          }
          updated = {
            ...entry,
            text: item.text ?? entry.text,
            status: item.status ?? entry.status,
          };
          return updated;
        });
        ctx.state.taskItems.set(sessionId, next);
        ctx.recordProgress(sessionId);
        ctx.emit(
          sessionId,
          "task.item.updated",
          {
            id: item.id,
            text: item.text,
            status: item.status,
          },
          { timestamp: item.timestamp, turn: item.turn },
        );
        return updated
          ? { ok: true, itemId, item: updated }
          : { ok: false, reason: `Task item not found: ${itemId}` };
      },
    },
    blockers: {
      record(sessionId, blocker) {
        const blockerId = blocker.id ?? `task-blocker:${sessionId}:${Date.now()}`;
        const blockerRecord = { ...blocker, id: blockerId };
        // Derive from the tape projection (not the raw Map) so the cache stays
        // consistent with durable truth across restarts, mirroring items.add.
        ctx.state.taskBlockers.set(sessionId, [
          ...liveTaskBlockerRecords(ctx, sessionId),
          blockerRecord,
        ]);
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.blocker.recorded", blockerRecord);
        return { ok: true, blockerId };
      },
      resolve(sessionId, blockerId) {
        // The verdict is tape-authoritative: after a restart the in-memory Map is
        // empty, so existence must be decided from the projected live blockers,
        // not the cache — otherwise resolve() would report "not found" while the
        // resolved event it emits actually takes effect on the tape.
        const live = liveTaskBlockerRecords(ctx, sessionId);
        const removed = live.some((entry) => entry.id === blockerId);
        ctx.state.taskBlockers.set(
          sessionId,
          live.filter((entry) => entry.id !== blockerId),
        );
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.blocker.resolved", { blockerId });
        return removed ? { ok: true, blockerId } : { ok: false, reason: "Blocker not found" };
      },
    },
    target: {
      getDescriptor: () => ({
        primaryRoot: ctx.runtime.identity.workspaceRoot,
        roots: [ctx.runtime.identity.workspaceRoot],
      }),
    },
    acceptance: {
      record(sessionId, inputValue) {
        ctx.emit(sessionId, "task.acceptance.recorded", inputValue);
        return { ok: true, status: inputValue.status };
      },
    },
  };
}
