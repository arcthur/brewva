import {
  BrewvaCause,
  BrewvaEffect,
  BrewvaProviderRequestScope,
  BrewvaQueue,
  BrewvaStream,
  runPromiseAtBoundary,
  runWithLinkedAbortSignal,
  withBrewvaObservability,
} from "@brewva/brewva-effect";
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

export interface ProviderStreamSession<TApi extends Api> {
  stream: ProviderEventSink;
  output: AssistantMessage;
  composer: ProviderStreamingComposer;
  signal: AbortSignal;
  ensureStarted(): Promise<void>;
  resetOutput(): void;
}

interface RunProviderStreamOptions {
  signal?: AbortSignal;
  startMode?: "eager" | "lazy";
  sessionId?: string;
  tools?: Tool[];
}

function toProviderStreamError(error: unknown): ProviderStreamError {
  if (error instanceof ProviderStreamError) {
    return error;
  }
  return new ProviderStreamError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export function runProviderStream<TApi extends Api>(
  model: Model<TApi>,
  run: (session: ProviderStreamSession<TApi>) => Promise<void>,
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
          const offerEvent = async (
            event: Parameters<ProviderEventSink["push"]>[0],
            signal: AbortSignal,
          ): Promise<void> => {
            const offered = await runPromiseAtBoundary(BrewvaQueue.offer(queue, event), {
              signal,
            });
            if (offered) {
              return;
            }
            const error = new ProviderStreamError({
              message: "Provider stream buffer is full or closed",
            });
            failQueue(error);
            throw error;
          };
          const offerTerminalError = async (
            event: Parameters<ProviderEventSink["push"]>[0],
            error: ProviderStreamError,
            signal: AbortSignal | undefined,
          ): Promise<void> => {
            const offered = await runPromiseAtBoundary(BrewvaQueue.offer(queue, event), {
              signal,
            });
            if (offered) {
              BrewvaQueue.endUnsafe(queue);
              return;
            }
            failQueue(error);
          };
          const parseRegistry: StreamingParseRegistry =
            options.tools && options.tools.length > 0
              ? createStreamingParseRegistry(options.tools)
              : EMPTY_PARSE_REGISTRY;

          const producer = BrewvaEffect.tryPromise({
            try: async (effectSignal) => {
              await runWithLinkedAbortSignal(effectSignal, options.signal, async (signal) => {
                activeSignal = signal;
                const stream: ProviderEventSink = {
                  async push(event) {
                    await offerEvent(event, signal);
                  },
                  async end() {
                    BrewvaQueue.endUnsafe(queue);
                  },
                };
                let started = false;
                const ensureStarted = async () => {
                  if (started) {
                    return;
                  }
                  started = true;
                  await stream.push({ type: "start", partial: output });
                };
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
                  await ensureStarted();
                }
                await run(session);
                if (signal.aborted) {
                  throw new Error("Request was aborted");
                }
                await session.composer.finishAll();
                await ensureStarted();
                const reason = output.stopReason;
                if (reason === "aborted" || reason === "error") {
                  throw new Error(output.errorMessage || `Provider returned ${reason} stop reason`);
                }
                await stream.push({
                  type: "done",
                  reason,
                  message: output,
                });
                await stream.end();
              });
            },
            catch: toProviderStreamError,
          }).pipe(
            BrewvaEffect.catch((error) =>
              BrewvaEffect.promise(async () => {
                const providerError = toProviderStreamError(error);
                output.stopReason = activeSignal?.aborted ? "aborted" : "error";
                output.errorMessage = providerError.message;
                await offerTerminalError(
                  {
                    type: "error",
                    reason: output.stopReason,
                    error: output,
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
