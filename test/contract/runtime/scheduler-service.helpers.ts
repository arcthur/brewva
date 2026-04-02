import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  getNextCronRunAt,
  normalizeTimeZone,
  parseCronExpression,
  type BrewvaConfig,
  type SchedulerRuntimePort,
} from "@brewva/brewva-runtime";

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

export function schedulerRuntimePort(runtime: BrewvaRuntime): SchedulerRuntimePort {
  return {
    workspaceRoot: runtime.workspaceRoot,
    scheduleConfig: runtime.config.schedule,
    listSessionIds: () => runtime.events.listSessionIds(),
    listEvents: (targetSessionId, query) => runtime.events.list(targetSessionId, query),
    recordEvent: (input) => runtime.events.record(input),
    subscribeEvents: (listener) => runtime.events.subscribe(listener),
    getTruthState: (targetSessionId) => runtime.truth.getState(targetSessionId),
    getTaskState: (targetSessionId) => runtime.task.getState(targetSessionId),
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
    return getNextCronRunAt(parsed.expression, afterMs);
  }
  return getNextCronRunAt(parsed.expression, afterMs, { timeZone: normalizedTimeZone });
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
