import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import { SCHEDULE_EVENT_TYPE } from "@brewva/brewva-vocabulary/schedule";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { RuntimeEventRecord } from "../runtime-ops-port.js";

export function toScheduleIntentProjection(
  input: ProtocolRecord,
  fallbackSessionId: string,
): ProtocolRecord {
  const intentId =
    typeof input.intentId === "string" && input.intentId.trim().length > 0
      ? input.intentId
      : typeof input.id === "string" && input.id.trim().length > 0
        ? input.id
        : `intent-${Date.now()}`;
  return {
    ...input,
    intentId,
    status: typeof input.status === "string" ? input.status : "active",
    reason: typeof input.reason === "string" ? input.reason : "scheduled",
    parentSessionId:
      typeof input.parentSessionId === "string" && input.parentSessionId.trim().length > 0
        ? input.parentSessionId
        : fallbackSessionId,
    continuityMode: typeof input.continuityMode === "string" ? input.continuityMode : "resume",
    ...(typeof input.runAt === "number" ? { runAt: input.runAt } : {}),
    ...(typeof input.nextRunAt === "number" ? { nextRunAt: input.nextRunAt } : {}),
    ...(typeof input.cron === "string" ? { cron: input.cron } : {}),
    ...(typeof input.timeZone === "string" ? { timeZone: input.timeZone } : {}),
    runCount: typeof input.runCount === "number" ? input.runCount : 0,
    maxRuns: typeof input.maxRuns === "number" ? input.maxRuns : 1,
  };
}

export function listScheduleIntentRows(
  ctx: HostedRuntimeOpsContext,
  query?: ProtocolRecord,
): ProtocolRecord[] {
  const parentSessionId =
    typeof query?.parentSessionId === "string" && query.parentSessionId.trim().length > 0
      ? query.parentSessionId
      : undefined;
  const candidateSessionIds = parentSessionId ? [parentSessionId] : ctx.sessionIds();
  const byIntentId = new Map<string, ProtocolRecord>();
  for (const event of candidateSessionIds.flatMap((sessionId) =>
    ctx.listEvents(sessionId, { type: SCHEDULE_EVENT_TYPE }),
  )) {
    const payload = ctx.readObjectPayload(event.payload);
    const intentId = scheduleIntentIdFor(event, payload);
    const previous = byIntentId.get(intentId);
    const runCount =
      (typeof previous?.runCount === "number" ? previous.runCount : 0) +
      (payload.kind === "fired" || payload.kind === "intent_fired" ? 1 : 0);
    const status = scheduleStatusFor(payload.kind, payload.status ?? previous?.status);
    const maxRuns =
      typeof payload.maxRuns === "number" && Number.isFinite(payload.maxRuns)
        ? Math.max(1, Math.trunc(payload.maxRuns))
        : typeof previous?.maxRuns === "number" && Number.isFinite(previous.maxRuns)
          ? Math.max(1, Math.trunc(previous.maxRuns))
          : 1;
    const nextRunAt =
      status !== "active" || runCount >= maxRuns
        ? undefined
        : typeof payload.nextRunAt === "number" && Number.isFinite(payload.nextRunAt)
          ? Math.trunc(payload.nextRunAt)
          : typeof payload.runAt === "number" && Number.isFinite(payload.runAt)
            ? Math.trunc(payload.runAt)
            : typeof payload.cron === "string" && payload.cron.trim().length > 0
              ? event.timestamp + 60_000
              : undefined;
    byIntentId.set(intentId, {
      ...previous,
      ...payload,
      id: intentId,
      intentId,
      parentSessionId: payload.parentSessionId ?? event.sessionId,
      status,
      runCount,
      nextRunAt,
      lastEventId: event.id,
      updatedAt: event.timestamp,
    });
  }
  return [...byIntentId.values()].toSorted((left, right) => {
    const leftTime = typeof left.updatedAt === "number" ? left.updatedAt : 0;
    const rightTime = typeof right.updatedAt === "number" ? right.updatedAt : 0;
    return rightTime - leftTime;
  });
}

function scheduleIntentIdFor(event: RuntimeEventRecord, payload: ProtocolRecord): string {
  const intentId = payload.intentId ?? payload.id;
  return typeof intentId === "string" && intentId.trim().length > 0 ? intentId : event.id;
}

function scheduleStatusFor(kind: unknown, previousStatus: unknown): string {
  if (kind === "cancelled" || kind === "intent_cancelled") return "cancelled";
  if (kind === "converged" || kind === "intent_converged") return "converged";
  if (typeof previousStatus === "string" && previousStatus.trim().length > 0) {
    return previousStatus;
  }
  return "active";
}
