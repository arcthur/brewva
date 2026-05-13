import {
  BrewvaEffect,
  startScopedSchedule,
  type ScopedScheduleHandle,
} from "@brewva/brewva-effect";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  maybeAdjudicateLatestTaskStall,
  type TaskStallAdjudicator,
} from "./task-stall-adjudication.js";

type IntervalHandle = ReturnType<typeof setInterval>;
type WatchdogTimer =
  | { kind: "managed"; handle: ScopedScheduleHandle }
  | { kind: "injected"; handle: IntervalHandle };

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLD_MS = 5 * 60_000;

export interface TaskProgressWatchdogOptions {
  runtime: BrewvaHostedRuntimePort;
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
  private readonly runtime: BrewvaHostedRuntimePort;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly thresholdMs: number;
  private readonly adjudicator?: TaskStallAdjudicator;
  private readonly setIntervalFn: TaskProgressWatchdogOptions["setIntervalFn"];
  private readonly clearIntervalFn: TaskProgressWatchdogOptions["clearIntervalFn"];
  private timer: WatchdogTimer | null = null;

  constructor(options: TaskProgressWatchdogOptions) {
    this.runtime = options.runtime;
    this.sessionId = options.sessionId;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = sanitizeDelayMs(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.thresholdMs = sanitizeDelayMs(options.thresholdMs, DEFAULT_THRESHOLD_MS);
    this.adjudicator = options.adjudicator;
    this.setIntervalFn = options.setIntervalFn;
    this.clearIntervalFn = options.clearIntervalFn;
  }

  start(): void {
    if (this.timer) return;
    if (this.setIntervalFn) {
      const handle = this.setIntervalFn(() => {
        this.poll();
      }, this.pollIntervalMs);
      handle?.unref?.();
      this.timer = { kind: "injected", handle };
      return;
    }
    this.timer = {
      kind: "managed",
      handle: startScopedSchedule({
        intervalMs: this.pollIntervalMs,
        run: () => BrewvaEffect.sync(() => this.poll()),
      }),
    };
  }

  async stop(): Promise<void> {
    if (!this.timer) return;
    const timer = this.timer;
    this.timer = null;
    if (timer.kind === "managed") {
      await timer.handle.close();
      return;
    }
    this.clearIntervalFn?.(timer.handle);
  }

  poll(): void {
    const polledAt = this.now();
    this.runtime.operator.session.stall.poll(this.sessionId, {
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
