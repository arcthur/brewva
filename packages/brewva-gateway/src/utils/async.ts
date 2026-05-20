import { runBoundaryOperation } from "@brewva/brewva-effect";
import { BrewvaDuration, BrewvaEffect } from "@brewva/brewva-effect/primitives";

export function sleep(ms: number): Promise<void> {
  return runBoundaryOperation(
    "gateway.async.sleep",
    BrewvaEffect.sleep(BrewvaDuration.millis(Math.max(0, ms))),
  );
}

export async function waitForAllSettledWithTimeout(
  promises: Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) {
    return;
  }

  await runBoundaryOperation(
    "gateway.async.waitForAllSettledWithTimeout",
    BrewvaEffect.race(
      BrewvaEffect.promise(() => Promise.allSettled(promises)).pipe(BrewvaEffect.asVoid),
      BrewvaEffect.sleep(BrewvaDuration.millis(Math.max(0, timeoutMs))),
    ),
  );
}
