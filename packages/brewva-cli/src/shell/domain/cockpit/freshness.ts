import type { CockpitFreshness, CockpitObservationCursor } from "./types.js";

export function createDefaultCockpitObservationCursor(
  input: Partial<CockpitObservationCursor> = {},
): CockpitObservationCursor {
  return {
    lastObservedAtRef: input.lastObservedAtRef,
    focusedRef: input.focusedRef,
    operatorPinnedRefs: [...new Set(input.operatorPinnedRefs ?? [])],
  };
}

const FRESH_DELTA_MS = 2_000;

export function resolveCockpitFreshness(input: {
  readonly cursor: CockpitObservationCursor;
  readonly sourceRef: string;
  readonly stateChangedAt: number;
  readonly sourceClock: ReadonlyMap<string, number>;
}): CockpitFreshness {
  const observedRef = input.cursor.lastObservedAtRef;
  if (!observedRef) {
    return "settled";
  }
  if (input.sourceRef === observedRef) {
    return "just_now";
  }
  const observedAt = input.sourceClock.get(observedRef);
  if (observedAt === undefined) {
    return "settled";
  }
  if (input.stateChangedAt <= observedAt) {
    return "settled";
  }
  return input.stateChangedAt - observedAt <= FRESH_DELTA_MS ? "fresh" : "stale";
}

export function isCockpitPinned(cursor: CockpitObservationCursor, ref: string): boolean {
  return cursor.focusedRef === ref || cursor.operatorPinnedRefs.includes(ref);
}
