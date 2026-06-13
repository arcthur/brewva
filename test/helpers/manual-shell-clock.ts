import type {
  ShellClock,
  ShellScheduledTimeout,
} from "../../packages/brewva-cli/src/shell/domain/clock.js";

interface ManualTimerEntry {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

export interface ManualShellClock extends ShellClock {
  /** Advance time, firing due timers in due-time order (FIFO on ties). */
  advance(deltaMs: number): void;
  /** Fire all pending timers regardless of their due time. */
  runAll(): void;
  /** Number of pending (scheduled, not cancelled, not fired) timers. */
  pendingCount(): number;
}

/**
 * Deterministic clock for tests. Timers fire synchronously inside
 * `advance`/`runAll`, in due-time order; callbacks scheduling new timers
 * within the advanced window are honored in the same call. Time is
 * monotonic even across reentrant `advance` calls and throwing callbacks.
 */
export function createManualShellClock(startAt = 0): ManualShellClock {
  let currentTime = startAt;
  let nextTimerId = 1;
  let entries: ManualTimerEntry[] = [];

  const takeNextDue = (deadline: number): ManualTimerEntry | undefined => {
    let next: ManualTimerEntry | undefined;
    for (const entry of entries) {
      if (entry.dueAt > deadline) {
        continue;
      }
      if (!next || entry.dueAt < next.dueAt || (entry.dueAt === next.dueAt && entry.id < next.id)) {
        next = entry;
      }
    }
    return next;
  };

  const drainDueTimers = (deadline: number): void => {
    for (;;) {
      const due = takeNextDue(deadline);
      if (!due) {
        break;
      }
      entries = entries.filter((entry) => entry !== due);
      currentTime = Math.max(currentTime, due.dueAt);
      due.callback();
    }
  };

  return {
    now: () => currentTime,
    schedule(callback, delayMs): ShellScheduledTimeout {
      const entry: ManualTimerEntry = {
        id: nextTimerId,
        dueAt: currentTime + Math.max(0, delayMs),
        callback,
      };
      nextTimerId += 1;
      entries.push(entry);
      return {
        cancel: () => {
          entries = entries.filter((candidate) => candidate !== entry);
        },
      };
    },
    advance(deltaMs) {
      const deadline = currentTime + Math.max(0, deltaMs);
      try {
        drainDueTimers(deadline);
      } finally {
        // Monotonic even when a callback throws or reentrantly advances
        // the clock past this call's deadline.
        currentTime = Math.max(currentTime, deadline);
      }
    },
    runAll() {
      drainDueTimers(Number.POSITIVE_INFINITY);
    },
    pendingCount() {
      return entries.length;
    },
  };
}
