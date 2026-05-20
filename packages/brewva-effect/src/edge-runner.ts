import { Effect, Scope } from "effect";
import { runPromiseAtBoundary, runSyncAtBoundary, type BrewvaRunOptions } from "./boundary.js";
import { mergeEdgeRunOptions, prepareScopedEdgeOperation } from "./edge-core.js";
import { withBrewvaObservability, type BrewvaObservationFields } from "./observability.js";

export interface BrewvaEdgeOperationOptions {
  readonly fields?: BrewvaObservationFields;
  readonly runOptions?: BrewvaRunOptions;
  readonly signal?: AbortSignal;
}

function prepareEdgeOperation<A, E>(
  name: string,
  effect: Effect.Effect<A, E, Scope.Scope>,
  options: BrewvaEdgeOperationOptions = {},
): Effect.Effect<A, E> {
  return prepareScopedEdgeOperation(
    name,
    effect,
    (operationName, fields) => withBrewvaObservability(operationName, fields),
    options.fields,
  );
}

export function runEdgeOperation<A, E>(
  name: string,
  effect: Effect.Effect<A, E, Scope.Scope>,
  options: BrewvaEdgeOperationOptions = {},
): Promise<A> {
  return runPromiseAtBoundary(
    prepareEdgeOperation(name, effect, options),
    mergeEdgeRunOptions(options),
  );
}

export function runBoundaryOperation<A, E>(
  name: string,
  effect: Effect.Effect<A, E>,
  options: BrewvaEdgeOperationOptions = {},
): Promise<A> {
  return runPromiseAtBoundary(
    effect.pipe(withBrewvaObservability(name, options.fields)),
    mergeEdgeRunOptions(options),
  );
}

export function runEdgeOperationSync<A, E>(
  name: string,
  effect: Effect.Effect<A, E, Scope.Scope>,
  options: Omit<BrewvaEdgeOperationOptions, "runOptions" | "signal"> = {},
): A {
  return runSyncAtBoundary(prepareEdgeOperation(name, effect, options));
}
