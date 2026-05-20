import { Effect, Scope } from "effect";
import { BrewvaBoundaryFailure } from "./errors.js";
import {
  makeScopedInterval,
  type BoundaryIntervalOptions,
  type ScopedInterval,
} from "./schedules.js";

export function addScopedFinalizer(
  finalizer: () => void | Promise<void>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.addFinalizer(() => Effect.promise(() => Promise.resolve(finalizer())));
}

export function scopedResource<A>(
  acquire: () => A | Promise<A>,
  release: (resource: A) => void | Promise<void>,
): Effect.Effect<A, BrewvaBoundaryFailure, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => Promise.resolve(acquire()),
      catch: (error) =>
        error instanceof BrewvaBoundaryFailure
          ? error
          : new BrewvaBoundaryFailure({
              message: "scopedResource.acquire failed",
              cause: error,
            }),
    }),
    (resource) => Effect.promise(() => Promise.resolve(release(resource))),
  );
}

export function scopedInterval<E = unknown>(
  options: BoundaryIntervalOptions<E>,
): Effect.Effect<ScopedInterval, never, Scope.Scope> {
  return makeScopedInterval(options);
}
