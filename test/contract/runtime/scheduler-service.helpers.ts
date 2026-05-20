import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SchedulerRuntimePort } from "@brewva/brewva-gateway/daemon";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import {
  getNextCronRunAt,
  normalizeTimeZone,
  parseCronExpression,
} from "@brewva/brewva-runtime/protocol";
import type { HostedRuntimeAdapterPort } from "../../helpers/runtime.js";

export function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-scheduler-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  writeFileSync(
    join(workspace, ".brewva", "brewva.json"),
    JSON.stringify(
      {
        schedule: {
          enabled: true,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return workspace;
}

export function createSchedulerConfig(mutate?: (config: BrewvaConfig) => void): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.schedule.enabled = true;
  mutate?.(config);
  return config;
}

export function schedulerRuntimePort(runtime: HostedRuntimeAdapterPort): SchedulerRuntimePort {
  return {
    workspaceRoot: runtime.identity.workspaceRoot,
    scheduleConfig: runtime.config.schedule,
    listSessionIds: () => runtime.ops.events.records.listSessionIds(),
    listEvents: (targetSessionId, query) => runtime.ops.events.records.list(targetSessionId, query),
    scheduleEvents: runtime.ops.schedule.events,
    subscribeEvents: (listener) => runtime.ops.events.records.subscribe(listener),
    getClaimState: (targetSessionId) => runtime.ops.claim.state.get(targetSessionId),
    getTaskState: (targetSessionId) => runtime.ops.task.state.get(targetSessionId),
  };
}

const RECURRING_JITTER_INTERVAL_RATIO = 0.1;
const MAX_RECURRING_JITTER_MS = 15 * 60 * 1000;

function hashStringToFraction(source: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

function getExactCronNextRunAt(
  cronExpression: string,
  afterMs: number,
  timeZone?: string,
): number | undefined {
  const parsed = parseCronExpression(cronExpression);
  if (!parsed.ok) return undefined;
  const normalizedTimeZone = timeZone ? normalizeTimeZone(timeZone) : undefined;
  if (!normalizedTimeZone) {
    return getNextCronRunAt(parsed.expression, afterMs).getTime();
  }
  return getNextCronRunAt(parsed.expression, afterMs, {
    timeZone: normalizedTimeZone,
  }).getTime();
}

export function computeExpectedRecurringJitteredNextRunAt(input: {
  intentId: string;
  cronExpression: string;
  afterMs: number;
  timeZone?: string;
}): number | undefined {
  const exactNextRunAt = getExactCronNextRunAt(input.cronExpression, input.afterMs, input.timeZone);
  if (exactNextRunAt === undefined) return undefined;

  const followingRunAt = getExactCronNextRunAt(
    input.cronExpression,
    exactNextRunAt,
    input.timeZone,
  );
  if (
    followingRunAt === undefined ||
    !Number.isFinite(followingRunAt) ||
    followingRunAt <= exactNextRunAt
  ) {
    return exactNextRunAt;
  }

  const intervalMs = followingRunAt - exactNextRunAt;
  const jitterMs = Math.floor(
    Math.min(
      MAX_RECURRING_JITTER_MS,
      intervalMs * RECURRING_JITTER_INTERVAL_RATIO * hashStringToFraction(input.intentId),
    ),
  );
  return exactNextRunAt + jitterMs;
}
