import { Effect } from "effect";
import {
  BrewvaBoundaryFailure,
  BrewvaCancelled,
  BrewvaInterruptedError,
  type BrewvaBoundaryError,
} from "./errors.js";

export type BrewvaBoundaryEffect<A, E = never> = Effect.Effect<A, E>;
export type BrewvaRunOptions = Effect.RunOptions;

export function runPromiseAtBoundary<A, E>(
  effect: BrewvaBoundaryEffect<A, E>,
  options?: BrewvaRunOptions,
): Promise<A> {
  return Effect.runPromise(effect, options);
}

export function runSyncAtBoundary<A, E>(effect: BrewvaBoundaryEffect<A, E>): A {
  return Effect.runSync(effect);
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof BrewvaCancelled || error instanceof BrewvaInterruptedError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /aborted|cancelled|canceled|interrupted/i.test(error.message)
  );
}

function toBrewvaBoundaryError(error: unknown, wasCancelled = false): BrewvaBoundaryError {
  if (error instanceof BrewvaBoundaryFailure || error instanceof BrewvaCancelled) {
    return error;
  }
  if (wasCancelled || isAbortLikeError(error)) {
    return new BrewvaCancelled({
      message: error instanceof Error ? error.message : "Boundary operation cancelled",
    });
  }
  return new BrewvaBoundaryFailure({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

/**
 * Wraps an edge Promise that is already short-lived or externally serialized.
 *
 * Do not use this for work that must stop on fiber interruption; use
 * fromAbortableBoundaryPromise or fromInterruptiblePromise when the callback
 * can honor an AbortSignal.
 */
export function fromBoundaryPromise<A>(
  run: () => PromiseLike<A> | A,
): Effect.Effect<A, BrewvaBoundaryFailure> {
  return Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (error) =>
      error instanceof BrewvaBoundaryFailure
        ? error
        : new BrewvaBoundaryFailure({
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
  });
}

function linkAbortSignal(
  signal: AbortSignal | undefined,
  abort: () => void,
): (() => void) | undefined {
  if (!signal) {
    return undefined;
  }
  if (signal.aborted) {
    abort();
    return undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export function withAbortSignal<A, E, R>(
  useSignal: (signal: AbortSignal) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.flatMap(
    Effect.sync(() => new AbortController()),
    (controller) =>
      useSignal(controller.signal).pipe(Effect.ensuring(Effect.sync(() => controller.abort()))),
  );
}

/**
 * Wraps a Promise boundary that can be cancelled by the owning Effect fiber.
 */
export function fromInterruptiblePromise<A>(
  run: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, BrewvaBoundaryError> {
  return fromAbortableBoundaryPromise(run);
}

export async function runWithLinkedAbortSignal<A>(
  effectSignal: AbortSignal | undefined,
  externalSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => PromiseLike<A>,
): Promise<A> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanups = [
    linkAbortSignal(effectSignal, abort),
    linkAbortSignal(externalSignal, abort),
  ].filter((cleanup): cleanup is () => void => cleanup !== undefined);

  try {
    return await run(controller.signal);
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
}

/**
 * Wraps a Promise boundary with both Effect interruption and an optional
 * external AbortSignal linked into the callback signal.
 */
export function fromAbortableBoundaryPromise<A>(
  run: (signal: AbortSignal) => PromiseLike<A>,
  externalSignal?: AbortSignal,
): Effect.Effect<A, BrewvaBoundaryError> {
  return Effect.tryPromise({
    try: async (effectSignal) => {
      return await runWithLinkedAbortSignal(effectSignal, externalSignal, run);
    },
    catch: (error) =>
      toBrewvaBoundaryError(error, externalSignal?.aborted === true || isAbortLikeError(error)),
  });
}
