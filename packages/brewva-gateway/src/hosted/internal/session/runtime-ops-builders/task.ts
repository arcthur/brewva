import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { TaskItem } from "@brewva/brewva-vocabulary/task";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

function normalizeBlocker(value: ProtocolRecord): { message: string; source?: string } | undefined {
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (!message) {
    return undefined;
  }
  const source = typeof value.source === "string" ? value.source : undefined;
  return source ? { message, source } : { message };
}

export function buildTaskRuntimeOps(ctx: HostedRuntimeOpsContext): HostedRuntimeOpsPort["task"] {
  const { taskSpec, taskItems, taskBlockers } = ctx.projections;
  return {
    spec: {
      set(sessionId, spec): void {
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.spec.set", { spec });
      },
    },
    state: {
      get(sessionId) {
        const spec = taskSpec(sessionId);
        return {
          ...(spec ? { spec } : {}),
          status: { phase: "active" },
          acceptance: { status: "pending" },
          items: taskItems(sessionId),
          blockers: taskBlockers(sessionId)
            .map(normalizeBlocker)
            .filter((value): value is { message: string; source?: string } => value !== undefined),
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
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.item.added", taskItem, {
          timestamp: item.timestamp,
          turn: item.turn,
        });
        return { ok: true, itemId: taskItem.id, item: taskItem };
      },
      update(sessionId, item) {
        const itemId = item.id;
        const existing = taskItems(sessionId).find((entry) => entry.id === itemId);
        if (!existing) {
          return { ok: false, reason: `Task item not found: ${itemId}` };
        }
        const updated: TaskItem = {
          ...existing,
          text: item.text ?? existing.text,
          status: item.status ?? existing.status,
        };
        ctx.recordProgress(sessionId);
        ctx.emit(
          sessionId,
          "task.item.updated",
          { id: item.id, text: item.text, status: item.status },
          { timestamp: item.timestamp, turn: item.turn },
        );
        return { ok: true, itemId, item: updated };
      },
    },
    blockers: {
      record(sessionId, blocker) {
        const blockerId = blocker.id ?? `task-blocker:${sessionId}:${Date.now()}`;
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.blocker.recorded", { ...blocker, id: blockerId });
        return { ok: true, blockerId };
      },
      resolve(sessionId, blockerId) {
        // The verdict is read straight from the tape projection (no cache): after
        // a restart the recorded blocker is still seen, so resolve() reports the
        // real existence rather than "not found" from stale in-memory state.
        const removed = taskBlockers(sessionId).some((entry) => entry.id === blockerId);
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
