import { Duration, Effect, Exit, Fiber, Schedule, Scope } from "effect";
import { runPromiseAtBoundary, runSyncAtBoundary } from "./boundary.js";

export interface BoundaryHandle {
  close(): Promise<void>;
}

export type BoundaryIntervalHandle = BoundaryHandle;
export type BoundaryTimeoutHandle = BoundaryHandle;

export interface BoundaryIntervalOptions<E = unknown> {
  intervalMs: number;
  run: () => Effect.Effect<void, E>;
  onError?: (error: unknown) => void;
  runImmediately?: boolean;
}

export interface BoundaryTimeoutOptions<E = unknown> {
  delayMs: number;
  run: () => Effect.Effect<void, E>;
  onError?: (error: unknown) => void;
}

export interface ScopedInterval {
  close: Effect.Effect<void>;
}

export interface ScopedTimeout {
  close: Effect.Effect<void>;
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

export function sleepAtBoundary(delayMs: number): Promise<void> {
  return runPromiseAtBoundary(Effect.sleep(Duration.millis(normalizeSleepDelayMs(delayMs))));
}

export function makeScopedInterval<E = unknown>(
  options: BoundaryIntervalOptions<E>,
): Effect.Effect<ScopedInterval, never, Scope.Scope> {
  const interval = Duration.millis(normalizeIntervalMs(options.intervalMs));
  const tick = scheduledTick(options);
  const loop = (
    options.runImmediately
      ? tick.pipe(Effect.repeat(Schedule.spaced(interval)))
      : Effect.sleep(interval).pipe(
          Effect.andThen(tick.pipe(Effect.repeat(Schedule.spaced(interval)))),
        )
  ).pipe(Effect.asVoid);

  return Effect.gen(function* () {
    const fiber = yield* loop.pipe(
      Effect.forkScoped({
        startImmediately: true,
      }),
    );
    return {
      close: Fiber.interrupt(fiber).pipe(Effect.asVoid),
    };
  });
}

export function makeScopedTimeout<E = unknown>(
  options: BoundaryTimeoutOptions<E>,
): Effect.Effect<ScopedTimeout, never, Scope.Scope> {
  return Effect.gen(function* () {
    const fiber = yield* Effect.sleep(Duration.millis(normalizeDelayMs(options.delayMs))).pipe(
      Effect.andThen(scheduledTick(options)),
      Effect.forkScoped({
        startImmediately: true,
      }),
    );
    return {
      close: Fiber.interrupt(fiber).pipe(Effect.asVoid),
    };
  });
}

export function startBoundaryInterval<E = unknown>(
  options: BoundaryIntervalOptions<E>,
): BoundaryIntervalHandle {
  const scope = runSyncAtBoundary(Scope.make());
  let closed = false;
  const acquired = runPromiseAtBoundary(Scope.provide(scope)(makeScopedInterval(options))).catch(
    (error: unknown) => {
      options.onError?.(error);
      return undefined;
    },
  );

  return {
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await acquired;
      await runPromiseAtBoundary(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
}

export function startBoundaryTimeout<E = unknown>(
  options: BoundaryTimeoutOptions<E>,
): BoundaryTimeoutHandle {
  const scope = runSyncAtBoundary(Scope.make());
  let closed = false;
  const acquired = runPromiseAtBoundary(Scope.provide(scope)(makeScopedTimeout(options))).catch(
    (error: unknown) => {
      options.onError?.(error);
      return undefined;
    },
  );

  return {
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await acquired;
      await runPromiseAtBoundary(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
}
