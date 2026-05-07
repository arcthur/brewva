import { Context, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect";

export interface BrewvaRuntimeSpineOptions {
  readonly name?: string;
  readonly memoMap?: Layer.MemoMap;
  readonly observabilityLayer?: Layer.Layer<never>;
}

export interface BrewvaRuntimeSpine<R, ER = never> {
  readonly name: string | undefined;
  readonly layer: Layer.Layer<R, ER>;
  readonly memoMap: Layer.MemoMap;
  readonly managedRuntime: ManagedRuntime.ManagedRuntime<R, ER>;
  readonly context: () => Promise<Context.Context<R>>;
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions,
  ) => Fiber.Fiber<A, E | ER>;
  readonly runSync: <A, E>(effect: Effect.Effect<A, E, R>) => A;
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions,
  ) => Promise<A>;
  readonly runPromiseExit: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions,
  ) => Promise<Exit.Exit<A, E | ER>>;
  readonly dispose: () => Promise<void>;
}

export function createBrewvaRuntimeSpine<R, ER = never>(
  layer: Layer.Layer<R, ER>,
  options: BrewvaRuntimeSpineOptions = {},
): BrewvaRuntimeSpine<R, ER> {
  const memoMap = options.memoMap ?? Layer.makeMemoMapUnsafe();
  const runtimeLayer = options.observabilityLayer
    ? Layer.mergeAll(layer, options.observabilityLayer)
    : layer;
  const managedRuntime = ManagedRuntime.make(runtimeLayer, { memoMap });

  return {
    name: options.name,
    layer,
    memoMap,
    managedRuntime,
    context: () => managedRuntime.context(),
    runFork: (effect, runOptions) => managedRuntime.runFork(effect, runOptions),
    runSync: (effect) => managedRuntime.runSync(effect),
    runPromise: (effect, runOptions) => managedRuntime.runPromise(effect, runOptions),
    runPromiseExit: (effect, runOptions) => managedRuntime.runPromiseExit(effect, runOptions),
    dispose: () => managedRuntime.dispose(),
  };
}
