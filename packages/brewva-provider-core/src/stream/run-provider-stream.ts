import { BrewvaProviderRequestScope, withBrewvaObservability } from "@brewva/brewva-effect";
import {
  BrewvaCause,
  BrewvaEffect,
  BrewvaQueue,
  BrewvaStream,
} from "@brewva/brewva-effect/primitives";
import { linkAbortSignal } from "@brewva/brewva-std/async";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ProviderEventSink,
  Tool,
} from "../contracts/index.js";
import {
  ProviderRuntime,
  ProviderStreamError,
  type ProviderAssistantMessageStream,
} from "../contracts/index.js";
import { EMPTY_PARSE_REGISTRY, createStreamingParseRegistry } from "../parse/typebox-partialize.js";
import type { StreamingParseRegistry } from "../parse/types.js";
import { createAssistantMessage, resetAssistantMessage } from "./assistant-message.js";
import { ProviderStreamingComposer } from "./composer.js";
import { awaitAbortSignal, failProviderStream, toProviderStreamError } from "./effect-interop.js";

export interface ProviderStreamSession<TApi extends Api> {
  stream: ProviderEventSink;
  output: AssistantMessage;
  composer: ProviderStreamingComposer;
  signal: AbortSignal;
  ensureStarted(): BrewvaEffect.Effect<void, ProviderStreamError>;
  resetOutput(): void;
}

interface RunProviderStreamOptions {
  signal?: AbortSignal;
  startMode?: "eager" | "lazy";
  sessionId?: string;
  tools?: Tool[];
}

export function runProviderStream<TApi extends Api>(
  model: Model<TApi>,
  run: (session: ProviderStreamSession<TApi>) => BrewvaEffect.Effect<void, ProviderStreamError>,
  options: RunProviderStreamOptions = {},
): ProviderAssistantMessageStream {
  const providerScope = {
    provider: String(model.provider),
    model: String(model.id),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  };

  const program = BrewvaEffect.gen(function* () {
    const runtime = yield* ProviderRuntime;
    return BrewvaStream.callback<AssistantMessageEvent, ProviderStreamError>(
      (queue) =>
        BrewvaEffect.gen(function* () {
          const output = createAssistantMessage(model);
          let activeSignal: AbortSignal | undefined;

          const failQueue = (error: ProviderStreamError): void => {
            BrewvaQueue.failCauseUnsafe(queue, BrewvaCause.fail(error));
          };
          const offerEvent = (
            event: Parameters<ProviderEventSink["push"]>[0],
            signal: AbortSignal,
          ): BrewvaEffect.Effect<void, ProviderStreamError> =>
            BrewvaEffect.gen(function* () {
              const offered = yield* BrewvaEffect.race(
                BrewvaQueue.offer(queue, event),
                awaitAbortSignal(signal),
              );
              if (offered) {
                return;
              }
              const error = new ProviderStreamError({
                message: "Provider stream buffer is full or closed",
              });
              failQueue(error);
              return yield* BrewvaEffect.fail(error);
            });
          const offerTerminalError = (
            event: Parameters<ProviderEventSink["push"]>[0],
            error: ProviderStreamError,
            signal: AbortSignal | undefined,
          ): BrewvaEffect.Effect<void, ProviderStreamError> =>
            BrewvaEffect.gen(function* () {
              const offer = BrewvaQueue.offer(queue, event);
              const offered = signal
                ? yield* BrewvaEffect.race(offer, awaitAbortSignal(signal))
                : yield* offer;
              if (offered) {
                BrewvaQueue.endUnsafe(queue);
                return;
              }
              failQueue(error);
            });
          const parseRegistry: StreamingParseRegistry =
            options.tools && options.tools.length > 0
              ? createStreamingParseRegistry(options.tools)
              : EMPTY_PARSE_REGISTRY;

          const producer = BrewvaEffect.gen(function* () {
            const controller = new AbortController();
            const unlinkAbort = linkAbortSignal(options.signal, controller);
            yield* BrewvaEffect.addFinalizer(() =>
              BrewvaEffect.sync(() => {
                unlinkAbort();
                controller.abort();
              }),
            );
            const signal = controller.signal;
            activeSignal = signal;
            const stream: ProviderEventSink = {
              push(event) {
                return offerEvent(event, signal);
              },
              end() {
                return BrewvaEffect.sync(() => {
                  BrewvaQueue.endUnsafe(queue);
                });
              },
            };
            let started = false;
            const ensureStarted = () =>
              BrewvaEffect.gen(function* () {
                if (started) {
                  return;
                }
                started = true;
                yield* stream.push({ type: "start", partial: output });
              });
            let composer = new ProviderStreamingComposer(
              output,
              stream,
              ensureStarted,
              parseRegistry,
            );
            const resetOutput = () => {
              resetAssistantMessage(output);
              started = false;
              composer = new ProviderStreamingComposer(
                output,
                stream,
                ensureStarted,
                parseRegistry,
              );
            };
            const session: ProviderStreamSession<TApi> = {
              stream,
              output,
              signal,
              get composer() {
                return composer;
              },
              ensureStarted,
              resetOutput,
            };
            if (options.startMode !== "lazy") {
              yield* ensureStarted();
            }
            yield* run(session);
            if (signal.aborted) {
              return yield* failProviderStream("Request was aborted");
            }
            yield* session.composer.finishAll();
            yield* ensureStarted();
            const reason = output.stopReason;
            if (reason === "aborted" || reason === "error") {
              return yield* failProviderStream(
                output.errorMessage || `Provider returned ${reason} stop reason`,
              );
            }
            yield* stream.push({
              type: "done",
              reason,
              message: output,
            });
            yield* stream.end();
          }).pipe(
            BrewvaEffect.catchCause((cause) =>
              BrewvaEffect.gen(function* () {
                if (BrewvaCause.hasInterruptsOnly(cause)) {
                  return yield* BrewvaEffect.interrupt;
                }
                const providerError = toProviderStreamError(BrewvaCause.squash(cause));
                output.stopReason = activeSignal?.aborted ? "aborted" : "error";
                output.errorMessage = providerError.message;
                yield* offerTerminalError(
                  {
                    type: "error",
                    reason: output.stopReason,
                    error: output,
                    ...(providerError.retryable === undefined
                      ? {}
                      : { retryable: providerError.retryable }),
                  },
                  providerError,
                  activeSignal,
                );
              }),
            ),
          );

          yield* producer.pipe(BrewvaEffect.forkScoped({ startImmediately: true }));
        }).pipe(
          BrewvaEffect.provide(BrewvaProviderRequestScope.layer(providerScope)),
          withBrewvaObservability("brewva.provider.producer", providerScope),
        ),
      { bufferSize: runtime.streamBufferSize, strategy: "suspend" },
    );
  }).pipe(
    BrewvaEffect.provide(BrewvaProviderRequestScope.layer(providerScope)),
    withBrewvaObservability("brewva.provider.stream", providerScope),
  );

  return BrewvaStream.unwrap(program);
}
