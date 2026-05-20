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

export interface BrewvaServiceRuntime<I, S, ER = never> {
  readonly name: string | undefined;
  readonly spine: BrewvaRuntimeSpine<I, ER>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, I>, options?: Effect.RunOptions) => Promise<A>;
  readonly runExit: <A, E>(
    effect: Effect.Effect<A, E, I>,
    options?: Effect.RunOptions,
  ) => Promise<Exit.Exit<A, E | ER>>;
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, I>,
    options?: Effect.RunOptions,
  ) => Fiber.Fiber<A, E | ER>;
  readonly runService: <A, E>(
    operation: (service: S) => Effect.Effect<A, E, I>,
    options?: Effect.RunOptions,
  ) => Promise<A>;
  readonly runServiceExit: <A, E>(
    operation: (service: S) => Effect.Effect<A, E, I>,
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

export function createBrewvaServiceRuntime<I, S, ER = never>(
  service: Context.Service<I, S>,
  layer: Layer.Layer<I, ER>,
  options: BrewvaRuntimeSpineOptions = {},
): BrewvaServiceRuntime<I, S, ER> {
  const spine = createBrewvaRuntimeSpine(layer, options);
  const serviceEffect = <A, E>(
    operation: (service: S) => Effect.Effect<A, E, I>,
  ): Effect.Effect<A, E, I> => service.use(operation);

  return {
    name: options.name,
    spine,
    run: (effect, runOptions) => spine.runPromise(effect, runOptions),
    runExit: (effect, runOptions) => spine.runPromiseExit(effect, runOptions),
    runFork: (effect, runOptions) => spine.runFork(effect, runOptions),
    runService: (operation, runOptions) => spine.runPromise(serviceEffect(operation), runOptions),
    runServiceExit: (operation, runOptions) =>
      spine.runPromiseExit(serviceEffect(operation), runOptions),
    dispose: () => spine.dispose(),
  };
}
