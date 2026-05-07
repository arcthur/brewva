import { BrewvaEffect, BrewvaStream, fromAbortableBoundaryPromise } from "@brewva/brewva-effect";
import type { ProviderRuntime, ProviderStreamError } from "@brewva/brewva-provider-core/contracts";
import type { BrewvaRegisteredModel, BrewvaResolvedRequestAuth } from "../contracts/provider.js";
import {
  BrewvaTurnScope,
  type BrewvaTurnEventDispatcher,
  type BrewvaTurnRuntimeError,
} from "./effect-runtime.js";
import type { BrewvaTurnLoopConfig } from "./loop.js";
import { convertToLlm } from "./messages.js";
import type {
  BrewvaTurnLoopAssistantMessage,
  BrewvaTurnLoopAssistantMessageEvent,
  BrewvaTurnLoopContext,
  BrewvaTurnLoopStreamContext,
  BrewvaTurnLoopStreamOptions,
} from "./types.js";

type TurnRuntimeEffect<A> = BrewvaEffect.Effect<
  A,
  BrewvaTurnRuntimeError | ProviderStreamError,
  ProviderRuntime | BrewvaTurnScope
>;

export function streamAssistantResponse(
  context: BrewvaTurnLoopContext,
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  dispatcher: BrewvaTurnEventDispatcher,
): TurnRuntimeEffect<BrewvaTurnLoopAssistantMessage> {
  return BrewvaEffect.gen(function* () {
    let messages = context.messages;
    if (config.transformContext) {
      messages = yield* fromAbortableBoundaryPromise(
        (abortSignal) =>
          config.transformContext?.(messages, abortSignal) ?? Promise.resolve(messages),
        signal,
      );
    }

    let requestAuth: BrewvaResolvedRequestAuth = { ok: true };
    if (config.resolveRequestAuth) {
      requestAuth = yield* fromAbortableBoundaryPromise(async (abortSignal) => {
        const resolvedAuth = await config.resolveRequestAuth?.(config.model, abortSignal);
        return resolvedAuth ?? requestAuth;
      }, signal);
    }

    if (!requestAuth.ok) {
      const failure = createFailureAssistantMessage(config.model, requestAuth.error, "error");
      yield* dispatcher.emit({ type: "message_start", message: { ...failure } });
      context.messages.push(failure);
      const messageEnd = yield* dispatcher.emit({ type: "message_end", message: failure });
      const committedFailure =
        messageEnd?.type === "message_end" && messageEnd.message.role === "assistant"
          ? messageEnd.message
          : failure;
      context.messages[context.messages.length - 1] = committedFailure;
      return committedFailure;
    }

    const streamContext: BrewvaTurnLoopStreamContext = {
      systemPrompt: context.systemPrompt,
      messages: convertToLlm(messages),
      tools: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };

    const streamOptions: BrewvaTurnLoopStreamOptions = {
      reasoning: config.reasoning,
      signal,
      apiKey: requestAuth.apiKey,
      transport: config.transport,
      sessionId: config.sessionId,
      cachePolicy: config.cachePolicy,
      onCacheRender: config.onCacheRender,
      onPayload: config.onPayload,
      headers: requestAuth.headers,
      maxRetryDelayMs: config.maxRetryDelayMs,
      thinkingBudgets: config.thinkingBudgets,
      resolveFile: config.resolveFile,
    };

    const response = config.streamFn(config.model, streamContext, streamOptions);
    let partialMessage: BrewvaTurnLoopAssistantMessage | null = null;
    let addedPartial = false;
    let finalMessage: BrewvaTurnLoopAssistantMessage | null = null;

    yield* response.pipe(
      BrewvaStream.runForEach((event) =>
        BrewvaEffect.gen(function* () {
          yield* BrewvaEffect.sync(() => {
            if (event.type === "done") {
              finalMessage = event.message;
            } else if (event.type === "error") {
              finalMessage = event.error;
            }
          });
          yield* handleAssistantStreamEvent(event, context, dispatcher, {
            partialMessage,
            addedPartial,
            updateState(nextPartial, nextAdded) {
              partialMessage = nextPartial;
              addedPartial = nextAdded;
            },
          });
        }),
      ),
    );

    const resolvedFinalMessage =
      finalMessage ??
      createFailureAssistantMessage(
        config.model,
        "Provider stream ended before producing a final message",
        "error",
      );
    if (addedPartial) {
      context.messages[context.messages.length - 1] = resolvedFinalMessage;
    } else {
      context.messages.push(resolvedFinalMessage);
      yield* dispatcher.emit({ type: "message_start", message: { ...resolvedFinalMessage } });
    }
    const messageEnd = yield* dispatcher.emit({
      type: "message_end",
      message: resolvedFinalMessage,
    });
    const committedMessage =
      messageEnd?.type === "message_end" && messageEnd.message.role === "assistant"
        ? messageEnd.message
        : resolvedFinalMessage;
    context.messages[context.messages.length - 1] = committedMessage;
    return committedMessage;
  });
}

function handleAssistantStreamEvent(
  event: BrewvaTurnLoopAssistantMessageEvent,
  context: BrewvaTurnLoopContext,
  dispatcher: BrewvaTurnEventDispatcher,
  state: {
    partialMessage: BrewvaTurnLoopAssistantMessage | null;
    addedPartial: boolean;
    updateState(partialMessage: BrewvaTurnLoopAssistantMessage | null, addedPartial: boolean): void;
  },
): TurnRuntimeEffect<void> {
  switch (event.type) {
    case "start":
      return BrewvaEffect.gen(function* () {
        state.updateState(event.partial, true);
        context.messages.push(event.partial);
        yield* dispatcher.emit({ type: "message_start", message: { ...event.partial } });
      });
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return BrewvaEffect.gen(function* () {
        if (state.partialMessage) {
          state.updateState(event.partial, state.addedPartial);
          context.messages[context.messages.length - 1] = event.partial;
          yield* dispatcher.emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...event.partial },
          });
        }
      });
    case "done":
    case "error":
      return BrewvaEffect.void;
  }
  return BrewvaEffect.void;
}

function createFailureAssistantMessage(
  model: BrewvaRegisteredModel,
  errorMessage: string,
  stopReason: "error" | "aborted",
): BrewvaTurnLoopAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}
