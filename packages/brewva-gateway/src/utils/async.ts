import { BrewvaDuration, BrewvaEffect, runPromiseAtBoundary } from "@brewva/brewva-effect";

export function sleep(ms: number): Promise<void> {
  return runPromiseAtBoundary(BrewvaEffect.sleep(BrewvaDuration.millis(Math.max(0, ms))));
}

export async function waitForAllSettledWithTimeout(
  promises: Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) {
    return;
  }

  await runPromiseAtBoundary(
    BrewvaEffect.race(
      BrewvaEffect.promise(() => Promise.allSettled(promises)).pipe(BrewvaEffect.asVoid),
      BrewvaEffect.sleep(BrewvaDuration.millis(Math.max(0, timeoutMs))),
    ),
  );
}
