import type { ScheduleIntentProjectionRecord } from "@brewva/brewva-vocabulary/schedule";
import { addMilliseconds, formatISO } from "date-fns";

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The config-authored self-improve lane is daemon-owned and carries the approval
 * envelope. Every model-facing schedule tool (`schedule_intent`, `follow_up`)
 * must refuse to mint, mutate, or cancel that reserved identity: the scheduler
 * folds every session's intents into one global map keyed by intentId, so a
 * colliding intentId — or acting AS the policy parent session — could perturb the
 * very record the approval resolver reads. This is the ingress half of
 * provenance-based authorization; the daemon-only origin stamp is the second.
 */
export function touchesReservedScheduleIdentity(input: {
  selfImprove: { readonly intentId: string; readonly parentSessionId: string };
  sessionId: string;
  intentId: string | undefined;
}): boolean {
  return (
    input.sessionId === input.selfImprove.parentSessionId ||
    (input.intentId !== undefined && input.intentId === input.selfImprove.intentId)
  );
}

export function formatIntentSummary(intent: ScheduleIntentProjectionRecord): string {
  const nextRunAtIso = typeof intent.nextRunAt === "number" ? formatISO(intent.nextRunAt) : "none";
  return [
    `- ${intent.intentId}`,
    `status=${intent.status}`,
    `runs=${intent.runCount}/${intent.maxRuns}`,
    `timeZone=${intent.timeZone ?? "none"}`,
    `nextRunAt=${nextRunAtIso}`,
    `reason=${intent.reason}`,
  ].join(" ");
}

export type ScheduleTargetResolution =
  | {
      ok: true;
      runAt: number;
      cron?: undefined;
      timeZone?: undefined;
    }
  | {
      ok: true;
      runAt?: undefined;
      cron: string;
      timeZone?: string;
    }
  | {
      ok: false;
      error: string;
    };

export function resolveScheduleTarget(params: {
  runAt?: number;
  delayMs?: number;
  cron?: string;
  timeZone?: string;
}): ScheduleTargetResolution {
  if (params.runAt !== undefined && params.delayMs !== undefined) {
    return { ok: false, error: "runAt_and_delayMs_are_mutually_exclusive" };
  }
  if (params.runAt !== undefined && params.cron !== undefined) {
    return { ok: false, error: "runAt_and_cron_are_mutually_exclusive" };
  }
  if (params.delayMs !== undefined && params.cron !== undefined) {
    return { ok: false, error: "delayMs_and_cron_are_mutually_exclusive" };
  }
  if (params.runAt === undefined && params.delayMs === undefined && params.cron === undefined) {
    return { ok: false, error: "missing_schedule_target" };
  }
  if (params.timeZone !== undefined && params.cron === undefined) {
    return { ok: false, error: "timeZone_requires_cron" };
  }
  if (params.cron !== undefined) {
    const cron = normalizeOptionalString(params.cron);
    if (!cron) {
      return { ok: false, error: "invalid_cron" };
    }
    const timeZone = normalizeOptionalString(params.timeZone);
    if (params.timeZone !== undefined && !timeZone) {
      return { ok: false, error: "invalid_time_zone" };
    }
    return { ok: true, cron, timeZone };
  }
  if (params.runAt !== undefined) {
    if (!Number.isFinite(params.runAt) || params.runAt <= 0) {
      return { ok: false, error: "invalid_runAt" };
    }
    return { ok: true, runAt: Math.floor(params.runAt) };
  }
  if (!Number.isFinite(params.delayMs) || (params.delayMs ?? 0) <= 0) {
    return { ok: false, error: "invalid_delayMs" };
  }
  return {
    ok: true,
    runAt: addMilliseconds(Date.now(), Math.floor(params.delayMs ?? 0)).getTime(),
  };
}

export type SchedulePatchResolution =
  | {
      ok: true;
      hasScheduleUpdate: false;
    }
  | {
      ok: true;
      hasScheduleUpdate: true;
      runAt?: number;
      cron?: string;
      timeZone?: string;
    }
  | {
      ok: false;
      error: string;
    };

export function resolveSchedulePatch(params: {
  runAt?: number;
  delayMs?: number;
  cron?: string;
  timeZone?: string;
}): SchedulePatchResolution {
  if (params.runAt !== undefined && params.delayMs !== undefined) {
    return { ok: false, error: "runAt_and_delayMs_are_mutually_exclusive" };
  }
  if (params.runAt !== undefined && params.cron !== undefined) {
    return { ok: false, error: "runAt_and_cron_are_mutually_exclusive" };
  }
  if (params.delayMs !== undefined && params.cron !== undefined) {
    return { ok: false, error: "delayMs_and_cron_are_mutually_exclusive" };
  }
  if (
    (params.runAt !== undefined || params.delayMs !== undefined) &&
    params.timeZone !== undefined
  ) {
    return { ok: false, error: "timeZone_requires_cron" };
  }

  if (params.cron !== undefined) {
    const cron = normalizeOptionalString(params.cron);
    if (!cron) return { ok: false, error: "invalid_cron" };
    const timeZone = normalizeOptionalString(params.timeZone);
    if (params.timeZone !== undefined && !timeZone) {
      return { ok: false, error: "invalid_time_zone" };
    }
    return { ok: true, hasScheduleUpdate: true, cron, timeZone };
  }

  if (params.runAt !== undefined) {
    if (!Number.isFinite(params.runAt) || params.runAt <= 0) {
      return { ok: false, error: "invalid_runAt" };
    }
    return { ok: true, hasScheduleUpdate: true, runAt: Math.floor(params.runAt) };
  }
  if (params.delayMs !== undefined) {
    if (!Number.isFinite(params.delayMs) || (params.delayMs ?? 0) <= 0) {
      return { ok: false, error: "invalid_delayMs" };
    }
    return {
      ok: true,
      hasScheduleUpdate: true,
      runAt: addMilliseconds(Date.now(), Math.floor(params.delayMs ?? 0)).getTime(),
    };
  }
  if (params.timeZone !== undefined) {
    const timeZone = normalizeOptionalString(params.timeZone);
    if (!timeZone) {
      return { ok: false, error: "invalid_time_zone" };
    }
    return { ok: true, hasScheduleUpdate: true, timeZone };
  }
  return { ok: true, hasScheduleUpdate: false };
}
