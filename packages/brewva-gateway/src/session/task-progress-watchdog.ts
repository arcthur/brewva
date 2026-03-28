import { type BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  maybeAdjudicateLatestTaskStall,
  type TaskStallAdjudicator,
} from "./task-stall-adjudication.js";

type IntervalHandle = ReturnType<typeof setInterval>;

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLD_MS = 5 * 60_000;

export interface TaskProgressWatchdogOptions {
  runtime: BrewvaRuntime;
  sessionId: string;
  now?: () => number;
  pollIntervalMs?: number;
  thresholdMs?: number;
  adjudicator?: TaskStallAdjudicator;
  setIntervalFn?: (callback: () => void, delayMs: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

function sanitizeDelayMs(value: number | undefined, fallbackMs: number): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallbackMs;
  return Math.max(1_000, candidate);
}

export class TaskProgressWatchdog {
  private readonly runtime: BrewvaRuntime;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly thresholdMs: number;
  private readonly adjudicator?: TaskStallAdjudicator;
  private readonly setIntervalFn: TaskProgressWatchdogOptions["setIntervalFn"];
  private readonly clearIntervalFn: TaskProgressWatchdogOptions["clearIntervalFn"];
  private timer: IntervalHandle | null = null;

  constructor(options: TaskProgressWatchdogOptions) {
    this.runtime = options.runtime;
    this.sessionId = options.sessionId;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = sanitizeDelayMs(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.thresholdMs = sanitizeDelayMs(options.thresholdMs, DEFAULT_THRESHOLD_MS);
    this.adjudicator = options.adjudicator;
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
    const polledAt = this.now();
    this.runtime.session.pollStall(this.sessionId, {
      now: polledAt,
      thresholdMs: this.thresholdMs,
    });
    maybeAdjudicateLatestTaskStall({
      runtime: this.runtime,
      sessionId: this.sessionId,
      adjudicator: this.adjudicator,
      now: () => polledAt,
    });
  }
}

export const TASK_PROGRESS_WATCHDOG_TEST_ONLY = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_THRESHOLD_MS,
  sanitizeDelayMs,
};
