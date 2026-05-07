import { Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import {
  runPromiseAtBoundary,
  runSyncAtBoundary,
  type BrewvaBoundaryEffect,
  type BrewvaRunOptions,
} from "./boundary.js";

export { TestClock as BrewvaTestClock };

export interface TestRuntime<A, E = unknown> {
  runPromise(effect: BrewvaBoundaryEffect<A, E>, options?: BrewvaRunOptions): Promise<A>;
  runSync(effect: BrewvaBoundaryEffect<A, E>): A;
  runPromiseExit(
    effect: BrewvaBoundaryEffect<A, E>,
    options?: BrewvaRunOptions,
  ): Promise<Exit.Exit<A, E>>;
  readonly testClockLayer: ReturnType<typeof TestClock.layer>;
}

export function createTestRuntime<A, E = unknown>(): TestRuntime<A, E> {
  return {
    runPromise: (effect) => runPromiseAtBoundary(effect),
    runSync: (effect) => runSyncAtBoundary(effect),
    runPromiseExit: (effect, options) => Effect.runPromiseExit(effect, options),
    testClockLayer: TestClock.layer(),
  };
}
