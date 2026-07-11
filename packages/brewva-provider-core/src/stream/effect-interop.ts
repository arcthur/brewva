import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import { ProviderStreamError, readErrorStatus } from "../contracts/index.js";

function readRetryableFlag(error: unknown): boolean | undefined {
  if (typeof error === "object" && error !== null) {
    const flag = (error as { retryable?: unknown }).retryable;
    if (typeof flag === "boolean") {
      return flag;
    }
  }
  // Provider-agnostic fallback for SDK-based providers (deepseek/openai/anthropic/google),
  // whose errors carry a numeric HTTP `status` but no `retryable` flag. Only UNAMBIGUOUS
  // permanent statuses fail fast: 401 unauthorized, 403 forbidden, 402 payment required.
  // 400/404 are ambiguous (context-length / transient routing) and 429/5xx are transient,
  // so they stay unset and keep the default retry behavior. `readErrorStatus` is the shared
  // reader (`contracts/error-status.ts`), also re-exported by the gateway's
  // `classifyProviderFailure` as `readProviderErrorStatus`. The runtime's
  // `isRetryableProviderError` is a SEPARATE gate: it walks the host's wrapped `cause` chain
  // for an explicit `retryable` flag and does no status parsing.
  const status = readErrorStatus(error);
  if (status === 401 || status === 402 || status === 403) {
    return false;
  }
  return undefined;
}

export function toProviderStreamError(error: unknown): ProviderStreamError {
  if (error instanceof ProviderStreamError) {
    return error;
  }
  const retryable = readRetryableFlag(error);
  return new ProviderStreamError({
    message: toErrorMessage(error),
    cause: error,
    ...(retryable === undefined ? {} : { retryable }),
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
