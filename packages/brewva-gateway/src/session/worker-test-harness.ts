import type { TaskProgressWatchdogOptions } from "./task-progress-watchdog.js";

export const WORKER_TEST_HARNESS_ENV_KEYS = [
  "BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES",
  "BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL",
  "BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS",
  "BREWVA_INTERNAL_GATEWAY_WATCHDOG_THRESHOLD_MS",
  "BREWVA_INTERNAL_GATEWAY_FAKE_ASSISTANT_TEXT",
] as const;

const WORKER_TEST_HARNESS_ENV = {
  enabled: "BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES",
  taskGoal: "BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL",
  pollIntervalMs: "BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS",
  thresholdMs: "BREWVA_INTERNAL_GATEWAY_WATCHDOG_THRESHOLD_MS",
  fakeAssistantText: "BREWVA_INTERNAL_GATEWAY_FAKE_ASSISTANT_TEXT",
} as const;

export type WorkerTestHarnessWatchdogOverrides = Pick<
  TaskProgressWatchdogOptions,
  "pollIntervalMs" | "thresholdMs"
> & {
  taskGoal?: string;
};

export interface WorkerTestHarnessConfig {
  enabled?: boolean;
  watchdog?: {
    taskGoal?: string;
    pollIntervalMs?: number;
    thresholdMs?: number;
  };
  fakeAssistantText?: string;
}

export interface ResolvedWorkerTestHarness {
  enabled: boolean;
  watchdog: WorkerTestHarnessWatchdogOverrides;
  fakeAssistantText?: string;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function serializePositiveInteger(value: number | undefined): string | undefined {
  const normalized = normalizePositiveInteger(value);
  return typeof normalized === "number" ? String(normalized) : undefined;
}

function readPositiveDurationEnv(
  env: NodeJS.ProcessEnv,
  name: keyof typeof WORKER_TEST_HARNESS_ENV,
): number | undefined {
  const raw = normalizeOptionalString(env[WORKER_TEST_HARNESS_ENV[name]]);
  if (!raw) {
    return undefined;
  }
  return normalizePositiveInteger(Number(raw));
}

export function buildWorkerTestHarnessEnv(
  config: WorkerTestHarnessConfig,
): Record<(typeof WORKER_TEST_HARNESS_ENV_KEYS)[number], string | undefined> {
  const taskGoal = normalizeOptionalString(config.watchdog?.taskGoal);
  const pollIntervalMs = serializePositiveInteger(config.watchdog?.pollIntervalMs);
  const thresholdMs = serializePositiveInteger(config.watchdog?.thresholdMs);
  const fakeAssistantText = normalizeOptionalString(config.fakeAssistantText);
  const hasOverrides =
    typeof taskGoal === "string" ||
    typeof pollIntervalMs === "string" ||
    typeof thresholdMs === "string" ||
    typeof fakeAssistantText === "string";
  const enabled = config.enabled ?? hasOverrides;

  return {
    BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES: enabled ? "1" : undefined,
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL: taskGoal,
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS: pollIntervalMs,
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_THRESHOLD_MS: thresholdMs,
    BREWVA_INTERNAL_GATEWAY_FAKE_ASSISTANT_TEXT: fakeAssistantText,
  };
}

export function resolveWorkerTestHarness(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWorkerTestHarness {
  if (env[WORKER_TEST_HARNESS_ENV.enabled] !== "1") {
    return {
      enabled: false,
      watchdog: {},
    };
  }

  return {
    enabled: true,
    watchdog: {
      taskGoal: normalizeOptionalString(env[WORKER_TEST_HARNESS_ENV.taskGoal]),
      pollIntervalMs: readPositiveDurationEnv(env, "pollIntervalMs"),
      thresholdMs: readPositiveDurationEnv(env, "thresholdMs"),
    },
    fakeAssistantText: normalizeOptionalString(env[WORKER_TEST_HARNESS_ENV.fakeAssistantText]),
  };
}
