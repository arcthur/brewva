import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { ProviderStreamError } from "../contracts/index.js";

export function toProviderStreamError(error: unknown): ProviderStreamError {
  if (error instanceof ProviderStreamError) {
    return error;
  }
  return new ProviderStreamError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export function providerTryPromise<T>(
  run: (signal: AbortSignal) => PromiseLike<T>,
): BrewvaEffect.Effect<T, ProviderStreamError> {
  return BrewvaEffect.tryPromise({
    try: run,
    catch: toProviderStreamError,
  });
}

export function failProviderStream(
  message: string,
  cause?: unknown,
): BrewvaEffect.Effect<never, ProviderStreamError> {
  return BrewvaEffect.fail(new ProviderStreamError({ message, cause }));
}

export function runAsyncIterableEffect<T>(
  iterable: AsyncIterable<T> | Iterable<T>,
  onItem: (item: T) => BrewvaEffect.Effect<void, ProviderStreamError>,
): BrewvaEffect.Effect<void, ProviderStreamError> {
  return BrewvaEffect.scoped(
    BrewvaEffect.gen(function* () {
      if (Symbol.asyncIterator in iterable) {
        const iterator = iterable[Symbol.asyncIterator]();
        yield* BrewvaEffect.addFinalizer(() =>
          providerTryPromise(async () => {
            await iterator.return?.();
          }).pipe(BrewvaEffect.catch(() => BrewvaEffect.void)),
        );

        while (true) {
          const next = yield* providerTryPromise(() => iterator.next());
          if (next.done) {
            return;
          }
          yield* onItem(next.value);
        }
      }

      if (Symbol.iterator in iterable) {
        const iterator = iterable[Symbol.iterator]();
        while (true) {
          const next = iterator.next();
          if (next.done) {
            return;
          }
          yield* onItem(next.value);
        }
      }
    }),
  );
}

export function awaitAbortSignal(
  signal: AbortSignal,
): BrewvaEffect.Effect<never, ProviderStreamError> {
  return BrewvaEffect.callback<never, ProviderStreamError>((resume) => {
    const abort = () => {
      resume(
        BrewvaEffect.fail(
          new ProviderStreamError({
            message: "Request was aborted",
          }),
        ),
      );
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    return BrewvaEffect.sync(() => signal.removeEventListener("abort", abort));
  });
}
