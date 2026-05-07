import { Duration, Effect, Exit, Schedule, Scope } from "effect";
import { runPromiseAtBoundary } from "./boundary.js";

export interface ManagedIntervalHandle {
  close(): Promise<void>;
}

export interface ScopedScheduleHandle {
  close(): Promise<void>;
}

export interface ScopedTimeoutHandle {
  close(): Promise<void>;
}

export interface ManagedIntervalOptions<E = unknown> {
  intervalMs: number;
  run: () => Effect.Effect<void, E>;
  onError?: (error: unknown) => void;
  runImmediately?: boolean;
}

function normalizeIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) {
    return 1;
  }
  return Math.max(1, Math.trunc(intervalMs));
}

function normalizeDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    return 1;
  }
  return Math.max(1, Math.trunc(delayMs));
}

function normalizeSleepDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    return 0;
  }
  return Math.max(0, Math.trunc(delayMs));
}

export function sleepAtBoundary(delayMs: number): Promise<void> {
  return runPromiseAtBoundary(Effect.sleep(Duration.millis(normalizeSleepDelayMs(delayMs))));
}

export function startManagedInterval<E = unknown>(
  options: ManagedIntervalOptions<E>,
): ManagedIntervalHandle {
  return startScopedSchedule(options);
}

function scheduledTick<E = unknown>(options: {
  run: () => Effect.Effect<void, E>;
  onError?: (error: unknown) => void;
}): Effect.Effect<void> {
  return Effect.suspend(options.run).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        options.onError?.(error);
      }),
    ),
    Effect.asVoid,
  );
}

export function startScopedSchedule<E = unknown>(
  options: ManagedIntervalOptions<E>,
): ScopedScheduleHandle {
  const interval = Duration.millis(normalizeIntervalMs(options.intervalMs));
  const scope = Effect.runSync(Scope.make());
  let closed = false;

  const tick = scheduledTick(options);
  const loop = (
    options.runImmediately
      ? tick.pipe(Effect.repeat(Schedule.spaced(interval)))
      : Effect.sleep(interval).pipe(
          Effect.andThen(tick.pipe(Effect.repeat(Schedule.spaced(interval)))),
        )
  ).pipe(Effect.asVoid);

  const launch = Effect.runPromise(
    Scope.provide(scope)(
      loop.pipe(
        Effect.forkScoped({
          startImmediately: true,
        }),
      ),
    ),
  ).catch((error: unknown) => {
    options.onError?.(error);
  });

  return {
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await launch;
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
}

export interface ScopedTimeoutOptions<E = unknown> {
  delayMs: number;
  run: () => Effect.Effect<void, E>;
  onError?: (error: unknown) => void;
}

export function startScopedTimeout<E = unknown>(
  options: ScopedTimeoutOptions<E>,
): ScopedTimeoutHandle {
  const scope = Effect.runSync(Scope.make());
  let closed = false;

  const launch = Effect.runPromise(
    Scope.provide(scope)(
      Effect.sleep(Duration.millis(normalizeDelayMs(options.delayMs))).pipe(
        Effect.andThen(scheduledTick(options)),
        Effect.forkScoped({
          startImmediately: true,
        }),
      ),
    ),
  ).catch((error: unknown) => {
    options.onError?.(error);
  });

  return {
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await launch;
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
}
