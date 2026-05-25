import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { TaskItem } from "@brewva/brewva-vocabulary/task";
import type { TaskSpec } from "@brewva/brewva-vocabulary/task";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

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
          items: ctx.state.taskItems.get(sessionId) ?? [],
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
        const items = ctx.state.taskItems.get(sessionId) ?? [];
        items.push(taskItem);
        ctx.state.taskItems.set(sessionId, items);
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.item.added", taskItem, {
          timestamp: item.timestamp,
          turn: item.turn,
        });
        return { ok: true, itemId: taskItem.id, item: taskItem };
      },
      update(sessionId, item) {
        const itemId = item.id;
        const items = ctx.state.taskItems.get(sessionId) ?? [];
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
        const blockers = ctx.state.taskBlockers.get(sessionId) ?? [];
        blockers.push(blockerRecord);
        ctx.state.taskBlockers.set(sessionId, blockers);
        ctx.recordProgress(sessionId);
        ctx.emit(sessionId, "task.blocker.recorded", blockerRecord);
        return { ok: true, blockerId };
      },
      resolve(sessionId, blockerId) {
        const blockers = ctx.state.taskBlockers.get(sessionId) ?? [];
        let removed = false;
        ctx.state.taskBlockers.set(
          sessionId,
          blockers.filter((entry) => {
            const matches =
              entry && typeof entry === "object" && !Array.isArray(entry) && entry.id === blockerId;
            removed ||= matches;
            return !matches;
          }),
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

function latestPayload(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  type: string,
): ProtocolRecord | undefined {
  const event = ctx.listEvents(sessionId, { type, last: 1 })[0];
  const payload = event?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
}

function taskSpecFor(ctx: HostedRuntimeOpsContext, sessionId: string): TaskSpec | undefined {
  const latestSpec = latestPayload(ctx, sessionId, "task.spec.set")?.spec;
  if (latestSpec && typeof latestSpec === "object" && !Array.isArray(latestSpec)) {
    return latestSpec as TaskSpec;
  }
  return ctx.state.taskSpecs.get(sessionId);
}

function taskBlockersFor(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): { message: string; source?: string }[] {
  const fromTape = ctx
    .listEvents(sessionId, { type: "task.blocker.recorded" })
    .map((event) => event.payload);
  const blockerSource =
    fromTape.length > 0 ? fromTape : (ctx.state.taskBlockers.get(sessionId) ?? []);
  return blockerSource
    .map((value) => {
      if (!value || typeof value !== "object") {
        return undefined;
      }
      const record = value as Record<string, unknown>;
      const message = typeof record.message === "string" ? record.message.trim() : "";
      if (!message) {
        return undefined;
      }
      const blockerRecordSource = typeof record.source === "string" ? record.source : undefined;
      return blockerRecordSource ? { message, source: blockerRecordSource } : { message };
    })
    .filter((value): value is { message: string; source?: string } => value !== undefined);
}
