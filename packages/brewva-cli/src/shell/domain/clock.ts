/**
 * Deterministic time seam for the interactive shell.
 *
 * Every debounce/throttle timer on the shell hot path (streaming flush,
 * status debounce, completion-refresh debounce, cockpit progress cadence)
 * is scheduled through this interface so tests can drive time manually
 * instead of sleeping. The scheduled handle owns its own cancellation,
 * which keeps call sites free of paired clear bookkeeping and keeps the
 * handle type opaque to consumers.
 *
 * The deterministic test implementation lives in
 * `test/helpers/manual-shell-clock.ts`; production code only ever needs
 * the system clock.
 */
export interface ShellScheduledTimeout {
  cancel(): void;
}

export interface ShellClock {
  /** Monotonic-enough wall time in milliseconds, used for elapsed math. */
  now(): number;
  /** Schedule a one-shot callback after `delayMs` milliseconds. */
  schedule(callback: () => void, delayMs: number): ShellScheduledTimeout;
}

export const systemShellClock: ShellClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return {
      cancel: () => clearTimeout(handle),
    };
  },
};
