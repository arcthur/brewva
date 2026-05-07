import { Effect, Scope } from "effect";
import { mergeEdgeRunOptions, prepareScopedEdgeOperation } from "./edge-core.js";
import { normalizeObservationFields } from "./observability.js";

export { Effect, Scope };

export type BrewvaPlatformEdgeObservationValue = string | number | boolean | null | undefined;
export type BrewvaPlatformEdgeObservationFields = Readonly<
  Record<string, BrewvaPlatformEdgeObservationValue>
>;

export interface BrewvaPlatformEdgeOperationOptions {
  readonly fields?: BrewvaPlatformEdgeObservationFields;
  readonly signal?: AbortSignal;
  readonly runOptions?: Effect.RunOptions;
}

function withPlatformEdgeObservability(name: string, fields?: BrewvaPlatformEdgeObservationFields) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const annotations = normalizeObservationFields(fields);
    const annotated =
      Object.keys(annotations).length === 0 ? effect : Effect.annotateLogs(effect, annotations);
    return Effect.withSpan(annotated, name, {
      attributes: annotations,
    }) as Effect.Effect<A, E, R>;
  };
}

function preparePlatformEdgeOperation<A, E>(
  name: string,
  effect: Effect.Effect<A, E, Scope.Scope>,
  options: BrewvaPlatformEdgeOperationOptions = {},
): Effect.Effect<A, E> {
  return prepareScopedEdgeOperation(
    name,
    effect,
    (operationName, fields) => withPlatformEdgeObservability(operationName, fields),
    options.fields,
  );
}

export function runPlatformEdgeOperation<A, E>(
  name: string,
  effect: Effect.Effect<A, E, Scope.Scope>,
  options: BrewvaPlatformEdgeOperationOptions = {},
): Promise<A> {
  return Effect.runPromise(preparePlatformEdgeOperation(name, effect, options), {
    ...mergeEdgeRunOptions(options),
  });
}

export function runPlatformEdgeOperationSync<A, E>(
  name: string,
  effect: Effect.Effect<A, E, Scope.Scope>,
  options: Omit<BrewvaPlatformEdgeOperationOptions, "runOptions" | "signal"> = {},
): A {
  return Effect.runSync(preparePlatformEdgeOperation(name, effect, options));
}
