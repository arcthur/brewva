import { computeBackoffMs } from "@brewva/brewva-std/backoff";
import { Duration, Effect, Ref, Schedule } from "effect";

export interface BrewvaRetryPolicy<E = unknown> {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly factor?: number;
  readonly jitter?: boolean;
  readonly delayFor?: (error: E, attempt: number) => number | undefined;
  readonly while?: (error: E) => boolean;
}

function normalizeRetryCount(maxRetries: number): number {
  if (!Number.isFinite(maxRetries)) {
    return 0;
  }
  return Math.max(0, Math.trunc(maxRetries));
}

function normalizeRetryDelayMs(baseDelayMs: number): number {
  if (!Number.isFinite(baseDelayMs)) {
    return 1;
  }
  return Math.max(1, Math.trunc(baseDelayMs));
}

export function makeBrewvaRetrySchedule(
  policy: Pick<BrewvaRetryPolicy, "baseDelayMs" | "factor" | "jitter" | "maxRetries">,
) {
  const maxRetries = normalizeRetryCount(policy.maxRetries);
  const baseDelay = Duration.millis(normalizeRetryDelayMs(policy.baseDelayMs));
  const factor = policy.factor ?? 2;
  const schedule = Schedule.exponential(baseDelay, factor).pipe(Schedule.take(maxRetries));
  return policy.jitter ? schedule.pipe(Schedule.jittered) : schedule;
}

function defaultRetryDelayMs(
  policy: Pick<BrewvaRetryPolicy, "baseDelayMs" | "factor">,
  attempt: number,
): number {
  const baseDelayMs = normalizeRetryDelayMs(policy.baseDelayMs);
  const factor = policy.factor ?? 2;
  // Uncapped exponential (the policy has no max-delay knob); the surrounding
  // normalizeRetryDelayMs enforces the >= 1ms floor. The Effect-native
  // Schedule.exponential path in makeBrewvaRetrySchedule is a Schedule combinator,
  // not a scalar, so it stays as-is.
  return normalizeRetryDelayMs(computeBackoffMs(attempt, { baseMs: baseDelayMs, factor }));
}

function makeServiceDirectedRetrySchedule<E>(
  policy: Pick<
    BrewvaRetryPolicy<E>,
    "baseDelayMs" | "delayFor" | "factor" | "jitter" | "maxRetries"
  >,
): Effect.Effect<Schedule.Schedule<number, E>> {
  return Effect.gen(function* () {
    const lastError = yield* Ref.make<E | undefined>(undefined);
    const maxRetries = normalizeRetryCount(policy.maxRetries);
    const schedule = Schedule.recurs(maxRetries).pipe(
      Schedule.tapInput((error: E) => Ref.set(lastError, error)),
      Schedule.addDelay((attempt) =>
        Ref.get(lastError).pipe(
          Effect.map((error) => {
            const requestedDelayMs =
              error === undefined ? undefined : policy.delayFor?.(error, attempt);
            return Duration.millis(
              normalizeRetryDelayMs(requestedDelayMs ?? defaultRetryDelayMs(policy, attempt)),
            );
          }),
        ),
      ),
    );

    return policy.jitter ? schedule.pipe(Schedule.jittered) : schedule;
  });
}

export function retryWithBrewvaPolicy<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  policy: BrewvaRetryPolicy<E>,
): Effect.Effect<A, E, R> {
  if (normalizeRetryCount(policy.maxRetries) === 0) {
    return effect;
  }
  if (policy.delayFor) {
    return Effect.gen(function* () {
      const schedule = yield* makeServiceDirectedRetrySchedule(policy);
      return yield* Effect.retry(effect, {
        schedule,
        while: policy.while,
      });
    });
  }
  return Effect.retry(effect, {
    schedule: makeBrewvaRetrySchedule(policy),
    while: policy.while,
  }) as Effect.Effect<A, E, R>;
}
