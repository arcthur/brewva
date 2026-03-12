import {
  SCAN_CONVERGENCE_BLOCKER_ID,
  type BrewvaRuntime,
  type TaskWatchdogPhase,
} from "@brewva/brewva-runtime";

type IntervalHandle = ReturnType<typeof setInterval>;
type TaskProgressWatchdogThresholdPolicy = Readonly<Record<TaskWatchdogPhase, number>>;

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLDS_MS: Record<TaskWatchdogPhase, number> = {
  investigate: 5 * 60_000,
  execute: 10 * 60_000,
  verify: 5 * 60_000,
};

export interface TaskProgressWatchdogOptions {
  runtime: BrewvaRuntime;
  sessionId: string;
  now?: () => number;
  pollIntervalMs?: number;
  thresholdsMs?: Partial<Record<TaskWatchdogPhase, number>>;
  setIntervalFn?: (callback: () => void, delayMs: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

function sanitizeDelayMs(value: number | undefined, fallbackMs: number): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallbackMs;
  return Math.max(1_000, candidate);
}

function createThresholdPolicy(
  overrides?: Partial<Record<TaskWatchdogPhase, number>>,
): TaskProgressWatchdogThresholdPolicy {
  return {
    investigate: sanitizeDelayMs(overrides?.investigate, DEFAULT_THRESHOLDS_MS.investigate),
    execute: sanitizeDelayMs(overrides?.execute, DEFAULT_THRESHOLDS_MS.execute),
    verify: sanitizeDelayMs(overrides?.verify, DEFAULT_THRESHOLDS_MS.verify),
  };
}

function buildDetectionKey(input: {
  phase: TaskWatchdogPhase;
  baselineProgressAt: number;
  suppressedBy: string | null;
}): string {
  return `${input.phase}:${input.baselineProgressAt}:${input.suppressedBy ?? ""}`;
}

export class TaskProgressWatchdog {
  private readonly runtime: BrewvaRuntime;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly thresholdPolicy: TaskProgressWatchdogThresholdPolicy;
  private readonly setIntervalFn: TaskProgressWatchdogOptions["setIntervalFn"];
  private readonly clearIntervalFn: TaskProgressWatchdogOptions["clearIntervalFn"];
  private timer: IntervalHandle | null = null;

  constructor(options: TaskProgressWatchdogOptions) {
    this.runtime = options.runtime;
    this.sessionId = options.sessionId;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = sanitizeDelayMs(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.thresholdPolicy = createThresholdPolicy(options.thresholdsMs);
    this.setIntervalFn =
      options.setIntervalFn ?? ((callback, delayMs) => setInterval(callback, delayMs));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle));
  }

  start(): void {
    if (this.timer) return;
    this.timer =
      this.setIntervalFn?.(() => {
        this.poll();
      }, this.pollIntervalMs) ?? null;
    this.timer?.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn?.(this.timer);
    this.timer = null;
  }

  poll(): void {
    this.runtime.session.pollStall(this.sessionId, {
      now: this.now(),
      thresholdsMs: this.thresholdPolicy,
    });
  }
}

export const TASK_PROGRESS_WATCHDOG_TEST_ONLY = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_THRESHOLDS_MS,
  createThresholdPolicy,
  sanitizeDelayMs,
  buildDetectionKey,
  SCAN_CONVERGENCE_BLOCKER_ID,
};
