import { nextScheduleRunAt, SCHEDULE_EVENT_TYPE } from "@brewva/brewva-vocabulary/schedule";
import type { ScheduleIntentProjectionRecord } from "@brewva/brewva-vocabulary/schedule";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";
import { listScheduleIntentRows, toScheduleIntentProjection } from "./schedule-projection.js";

export function buildScheduleRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["schedule"] {
  return {
    intents: {
      async create(sessionId, payload) {
        const base = toScheduleIntentProjection(
          {
            ...payload,
            intentId:
              typeof payload.intentId === "string" && payload.intentId.trim().length > 0
                ? payload.intentId
                : `intent-${Date.now()}`,
            status: "active",
            parentSessionId: sessionId,
          },
          sessionId,
        ) as ScheduleIntentProjectionRecord;
        // Persist `nextRunAt` so the projection and the daemon share one authoritative value.
        const nextRunAt = nextScheduleRunAt(base, { from: ctx.clock() });
        const intent: ScheduleIntentProjectionRecord =
          nextRunAt === null ? base : { ...base, nextRunAt };
        ctx.emit(sessionId, SCHEDULE_EVENT_TYPE, { kind: "intent_created", ...intent });
        return { ok: true, intent };
      },
      async update(sessionId, payload) {
        ctx.emit(sessionId, SCHEDULE_EVENT_TYPE, {
          kind: "intent_updated",
          ...payload,
        });
        const intent = listScheduleIntentRows(ctx, { parentSessionId: sessionId }).find(
          (row) => row.intentId === payload.intentId,
        );
        return {
          ok: true,
          intent: toScheduleIntentProjection(
            intent ?? payload,
            sessionId,
          ) as ScheduleIntentProjectionRecord,
        };
      },
      async cancel(sessionId, payload) {
        ctx.emit(sessionId, SCHEDULE_EVENT_TYPE, {
          kind: "intent_cancelled",
          ...payload,
        });
        const intent = listScheduleIntentRows(ctx, { parentSessionId: sessionId }).find(
          (row) => row.intentId === payload.intentId,
        );
        return {
          ok: true,
          intent: toScheduleIntentProjection(
            {
              ...(intent ?? payload),
              status: "cancelled",
            },
            sessionId,
          ) as ScheduleIntentProjectionRecord,
        };
      },
      async getProjectionSnapshot() {
        return {
          watermarkOffset: ctx
            .sessionIds()
            .reduce(
              (sum, sessionId) =>
                sum + ctx.listEvents(sessionId, { type: SCHEDULE_EVENT_TYPE }).length,
              0,
            ),
        };
      },
      async list(query) {
        return listScheduleIntentRows(ctx, query).map((row) =>
          toScheduleIntentProjection(row, "schedule"),
        ) as ScheduleIntentProjectionRecord[];
      },
    },
    events: {
      recordIntent(payload) {
        const eventPayload = ctx.readObjectPayload(payload);
        const sessionId =
          typeof eventPayload.parentSessionId === "string" && eventPayload.parentSessionId
            ? eventPayload.parentSessionId
            : "schedule";
        return ctx.emit(sessionId, SCHEDULE_EVENT_TYPE, payload);
      },
      recordWakeup(sessionId, payload) {
        return ctx.emit(sessionId, "schedule.wakeup", payload);
      },
      recordChildStarted(sessionId, payload) {
        return ctx.emit(sessionId, "schedule.child_session.started", payload);
      },
      recordChildFinished(sessionId, payload) {
        return ctx.emit(sessionId, "schedule.child_session.finished", payload);
      },
      recordChildFailed(sessionId, payload) {
        return ctx.emit(sessionId, "schedule.child_session.failed", payload);
      },
    },
  };
}
