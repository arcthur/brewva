import { Effect, Scope } from "effect";

export interface EdgeRunOptions {
  readonly signal?: AbortSignal;
  readonly runOptions?: Effect.RunOptions;
}

export type EdgeObserver<A, E, Fields> = (
  name: string,
  fields: Fields | undefined,
) => (effect: Effect.Effect<A, E, Scope.Scope>) => Effect.Effect<A, E, Scope.Scope>;

export function mergeEdgeRunOptions(options: EdgeRunOptions): Effect.RunOptions | undefined {
  if (!options.signal) {
    return options.runOptions;
  }
  return {
    ...options.runOptions,
    signal: options.signal,
  } as Effect.RunOptions;
}

export function prepareScopedEdgeOperation<A, E, Fields>(
  name: string,
  effect: Effect.Effect<A, E, Scope.Scope>,
  observe: EdgeObserver<A, E, Fields>,
  fields?: Fields,
): Effect.Effect<A, E> {
  return Effect.scoped(effect.pipe(observe(name, fields)));
}
