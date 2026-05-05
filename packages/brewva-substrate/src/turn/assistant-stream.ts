import type { BrewvaRegisteredModel, BrewvaResolvedRequestAuth } from "../contracts/provider.js";
import type { BrewvaTurnLoopConfig, BrewvaTurnLoopEventSink } from "./loop.js";
import { convertToLlm } from "./messages.js";
import type {
  BrewvaTurnLoopAssistantMessage,
  BrewvaTurnLoopAssistantMessageEvent,
  BrewvaTurnLoopContext,
  BrewvaTurnLoopStreamContext,
  BrewvaTurnLoopStreamOptions,
} from "./types.js";

export async function streamAssistantResponse(
  context: BrewvaTurnLoopContext,
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaTurnLoopEventSink,
): Promise<BrewvaTurnLoopAssistantMessage> {
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  let requestAuth: BrewvaResolvedRequestAuth = { ok: true };
  if (config.resolveRequestAuth) {
    requestAuth = await config.resolveRequestAuth(config.model);
  }

  if (!requestAuth.ok) {
    const failure = createFailureAssistantMessage(config.model, requestAuth.error, "error");
    await emit({ type: "message_start", message: { ...failure } });
    context.messages.push(failure);
    const messageEnd = await emit({ type: "message_end", message: failure });
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

  const response = await config.streamFn(config.model, streamContext, streamOptions);
  let partialMessage: BrewvaTurnLoopAssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    await handleAssistantStreamEvent(event, context, emit, {
      partialMessage,
      addedPartial,
      updateState(nextPartial, nextAdded) {
        partialMessage = nextPartial;
        addedPartial = nextAdded;
      },
    });
  }

  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  const messageEnd = await emit({ type: "message_end", message: finalMessage });
  const committedMessage =
    messageEnd?.type === "message_end" && messageEnd.message.role === "assistant"
      ? messageEnd.message
      : finalMessage;
  context.messages[context.messages.length - 1] = committedMessage;
  return committedMessage;
}

async function handleAssistantStreamEvent(
  event: BrewvaTurnLoopAssistantMessageEvent,
  context: BrewvaTurnLoopContext,
  emit: BrewvaTurnLoopEventSink,
  state: {
    partialMessage: BrewvaTurnLoopAssistantMessage | null;
    addedPartial: boolean;
    updateState(partialMessage: BrewvaTurnLoopAssistantMessage | null, addedPartial: boolean): void;
  },
): Promise<void> {
  switch (event.type) {
    case "start":
      state.updateState(event.partial, true);
      context.messages.push(event.partial);
      await emit({ type: "message_start", message: { ...event.partial } });
      return;
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      if (state.partialMessage) {
        state.updateState(event.partial, state.addedPartial);
        context.messages[context.messages.length - 1] = event.partial;
        await emit({
          type: "message_update",
          assistantMessageEvent: event,
          message: { ...event.partial },
        });
      }
      return;
    case "done":
    case "error":
      return;
  }
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
