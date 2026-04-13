import type { BrewvaRegisteredModel, BrewvaResolvedRequestAuth } from "@brewva/brewva-substrate";
import type {
  BrewvaAgentEngineAfterToolCallContext,
  BrewvaAgentEngineAssistantMessage,
  BrewvaAgentEngineAssistantMessageEvent,
  BrewvaAgentEngineBeforeToolCallContext,
  BrewvaAgentEngineEvent,
  BrewvaAgentEngineLlmMessage,
  BrewvaAgentEngineMessage,
  BrewvaAgentEngineResolveRequestAuth,
  BrewvaAgentEngineStreamContext,
  BrewvaAgentEngineStreamFunction,
  BrewvaAgentEngineStreamOptions,
  BrewvaAgentEngineThinkingBudgets,
  BrewvaAgentEngineThinkingLevel,
  BrewvaAgentEngineTool,
  BrewvaAgentEngineToolCall,
  BrewvaAgentEngineToolResult,
  BrewvaAgentEngineToolResultMessage,
  BrewvaAgentEngineTransport,
  BrewvaAgentEngineStopAfterToolResults,
} from "./agent-engine-types.js";
import { validateToolArguments, prepareToolArguments } from "./validate-tool-arguments.js";

type BrewvaAgentEventSink = (event: BrewvaAgentEngineEvent) => Promise<void> | void;

export interface BrewvaAgentLoopContext {
  systemPrompt: string;
  messages: BrewvaAgentEngineMessage[];
  tools: BrewvaAgentEngineTool[];
}

export interface BrewvaAgentLoopConfig {
  model: BrewvaRegisteredModel;
  reasoning?: BrewvaAgentEngineThinkingLevel;
  sessionId?: string;
  onPayload?: (payload: unknown, model: BrewvaRegisteredModel) => Promise<unknown>;
  transport: BrewvaAgentEngineTransport;
  thinkingBudgets?: BrewvaAgentEngineThinkingBudgets;
  maxRetryDelayMs?: number;
  streamFn: BrewvaAgentEngineStreamFunction;
  beforeToolCall?: (
    context: BrewvaAgentEngineBeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  afterToolCall?: (
    context: BrewvaAgentEngineAfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<
    | {
        content?: BrewvaAgentEngineToolResult["content"];
        details?: unknown;
        isError?: boolean;
      }
    | undefined
  >;
  transformContext?: (
    messages: BrewvaAgentEngineMessage[],
    signal?: AbortSignal,
  ) => Promise<BrewvaAgentEngineMessage[]>;
  getSteeringMessages?: () => Promise<BrewvaAgentEngineMessage[]>;
  getFollowUpMessages?: () => Promise<BrewvaAgentEngineMessage[]>;
  resolveRequestAuth?: BrewvaAgentEngineResolveRequestAuth;
  toolExecution?: "parallel" | "sequential";
  shouldStopAfterToolResults?: BrewvaAgentEngineStopAfterToolResults;
}

type PreparedToolCall = {
  kind: "prepared";
  toolCall: BrewvaAgentEngineToolCall;
  tool: BrewvaAgentEngineTool;
  args: unknown;
  phase: "prepare";
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: BrewvaAgentEngineToolResult;
  isError: boolean;
  phase: "classify" | "authorize";
};

type ExecutedToolCallOutcome = {
  result: BrewvaAgentEngineToolResult;
  isError: boolean;
  phase: "execute";
};

export async function runAgentLoop(
  prompts: BrewvaAgentEngineMessage[],
  context: BrewvaAgentLoopContext,
  config: BrewvaAgentLoopConfig,
  emit: BrewvaAgentEventSink,
  signal?: AbortSignal,
): Promise<BrewvaAgentEngineMessage[]> {
  const newMessages: BrewvaAgentEngineMessage[] = [...prompts];
  const currentContext: BrewvaAgentLoopContext = {
    ...context,
    messages: [...context.messages, ...prompts],
    tools: [...context.tools],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit);
  return newMessages;
}

async function runLoop(
  currentContext: BrewvaAgentLoopContext,
  newMessages: BrewvaAgentEngineMessage[],
  config: BrewvaAgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaAgentEventSink,
): Promise<void> {
  let firstTurn = true;
  let pendingMessages = (await config.getSteeringMessages?.()) ?? [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const message = await streamAssistantResponse(currentContext, config, signal, emit);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const toolCalls = message.content.filter(
        (content): content is BrewvaAgentEngineToolCall => content.type === "toolCall",
      );
      hasMoreToolCalls = toolCalls.length > 0;

      const toolResults: BrewvaAgentEngineToolResultMessage[] = [];
      if (hasMoreToolCalls) {
        toolResults.push(
          ...(await executeToolCalls(currentContext, message, toolCalls, config, signal, emit)),
        );
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });
      if (
        toolResults.length > 0 &&
        (await config.shouldStopAfterToolResults?.(toolResults)) === true
      ) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }
      pendingMessages = (await config.getSteeringMessages?.()) ?? [];
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

async function streamAssistantResponse(
  context: BrewvaAgentLoopContext,
  config: BrewvaAgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaAgentEventSink,
): Promise<BrewvaAgentEngineAssistantMessage> {
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
    await emit({ type: "message_end", message: failure });
    return failure;
  }

  const streamContext: BrewvaAgentEngineStreamContext = {
    systemPrompt: context.systemPrompt,
    messages: messages.filter(
      (message): message is BrewvaAgentEngineLlmMessage =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult",
    ),
    tools: context.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };

  const streamOptions: BrewvaAgentEngineStreamOptions = {
    reasoning: config.reasoning,
    signal,
    apiKey: requestAuth.apiKey,
    transport: config.transport,
    sessionId: config.sessionId,
    onPayload: config.onPayload,
    headers: requestAuth.headers,
    maxRetryDelayMs: config.maxRetryDelayMs,
    thinkingBudgets: config.thinkingBudgets,
  };

  const response = await config.streamFn(config.model, streamContext, streamOptions);
  let partialMessage: BrewvaAgentEngineAssistantMessage | null = null;
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
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

async function handleAssistantStreamEvent(
  event: BrewvaAgentEngineAssistantMessageEvent,
  context: BrewvaAgentLoopContext,
  emit: BrewvaAgentEventSink,
  state: {
    partialMessage: BrewvaAgentEngineAssistantMessage | null;
    addedPartial: boolean;
    updateState(
      partialMessage: BrewvaAgentEngineAssistantMessage | null,
      addedPartial: boolean,
    ): void;
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

async function executeToolCalls(
  currentContext: BrewvaAgentLoopContext,
  assistantMessage: BrewvaAgentEngineAssistantMessage,
  toolCalls: BrewvaAgentEngineToolCall[],
  config: BrewvaAgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaAgentEventSink,
): Promise<BrewvaAgentEngineToolResultMessage[]> {
  if (config.toolExecution === "sequential") {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      config,
      signal,
      emit,
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    config,
    signal,
    emit,
  );
}

async function executeToolCallsSequential(
  currentContext: BrewvaAgentLoopContext,
  assistantMessage: BrewvaAgentEngineAssistantMessage,
  toolCalls: BrewvaAgentEngineToolCall[],
  config: BrewvaAgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaAgentEventSink,
): Promise<BrewvaAgentEngineToolResultMessage[]> {
  const results: BrewvaAgentEngineToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    await emitToolExecutionPhaseChange(toolCall, "classify", emit, undefined, toolCall.arguments);

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
      emit,
    );
    if (preparation.kind === "immediate") {
      results.push(
        await emitToolCallOutcome(
          toolCall,
          preparation.result,
          preparation.isError,
          preparation.phase,
          toolCall.arguments,
          emit,
        ),
      );
      continue;
    }
    const executed = await executePreparedToolCall(preparation, signal, emit);
    results.push(
      await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
        emit,
      ),
    );
  }
  return results;
}

async function executeToolCallsParallel(
  currentContext: BrewvaAgentLoopContext,
  assistantMessage: BrewvaAgentEngineAssistantMessage,
  toolCalls: BrewvaAgentEngineToolCall[],
  config: BrewvaAgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaAgentEventSink,
): Promise<BrewvaAgentEngineToolResultMessage[]> {
  const results: BrewvaAgentEngineToolResultMessage[] = [];
  const runnableCalls: PreparedToolCall[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    await emitToolExecutionPhaseChange(toolCall, "classify", emit, undefined, toolCall.arguments);

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
      emit,
    );
    if (preparation.kind === "immediate") {
      results.push(
        await emitToolCallOutcome(
          toolCall,
          preparation.result,
          preparation.isError,
          preparation.phase,
          toolCall.arguments,
          emit,
        ),
      );
      continue;
    }
    runnableCalls.push(preparation);
  }

  const runningCalls = runnableCalls.map((prepared) => ({
    prepared,
    execution: executePreparedToolCall(prepared, signal, emit),
  }));

  for (const running of runningCalls) {
    const executed = await running.execution;
    results.push(
      await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        running.prepared,
        executed,
        config,
        signal,
        emit,
      ),
    );
  }

  return results;
}

async function prepareToolCall(
  currentContext: BrewvaAgentLoopContext,
  assistantMessage: BrewvaAgentEngineAssistantMessage,
  toolCall: BrewvaAgentEngineToolCall,
  config: BrewvaAgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaAgentEventSink,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const tool = currentContext.tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
      phase: "classify",
    };
  }

  try {
    const preparedToolCall = prepareToolArguments(tool, toolCall);
    const validatedArgs = validateToolArguments(tool, preparedToolCall);
    await emitToolExecutionPhaseChange(toolCall, "authorize", emit, "classify", validatedArgs);
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context: currentContext,
        },
        signal,
      );
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(beforeResult.reason ?? "Tool execution was blocked"),
          isError: true,
          phase: "authorize",
        };
      }
    }
    await emitToolExecutionPhaseChange(toolCall, "prepare", emit, "authorize", validatedArgs);
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs,
      phase: "prepare",
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
      phase: "classify",
    };
  }
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: BrewvaAgentEventSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];
  try {
    await emitToolExecutionPhaseChange(
      prepared.toolCall,
      "execute",
      emit,
      prepared.phase,
      prepared.args,
    );
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args,
      signal,
      (partialResult) => {
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    );
    await Promise.all(updateEvents);
    return { result, isError: result.isError === true, phase: "execute" };
  } catch (error) {
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
      phase: "execute",
    };
  }
}

async function finalizeExecutedToolCall(
  currentContext: BrewvaAgentLoopContext,
  assistantMessage: BrewvaAgentEngineAssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: BrewvaAgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaAgentEventSink,
): Promise<BrewvaAgentEngineToolResultMessage> {
  let result = executed.result;
  let isError = executed.isError;
  await emitToolExecutionPhaseChange(
    prepared.toolCall,
    "record",
    emit,
    executed.phase,
    prepared.args,
  );

  if (config.afterToolCall) {
    const afterResult = await config.afterToolCall(
      {
        assistantMessage,
        toolCall: prepared.toolCall,
        args: prepared.args,
        result,
        isError,
        context: currentContext,
      },
      signal,
    );
    if (afterResult) {
      result = {
        content: afterResult.content ?? result.content,
        details: afterResult.details ?? result.details,
        isError: afterResult.isError ?? result.isError,
      };
      isError = afterResult.isError ?? isError;
    }
  }

  return emitToolCallOutcome(prepared.toolCall, result, isError, "record", prepared.args, emit);
}

function createErrorToolResult(message: string): BrewvaAgentEngineToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: {},
    isError: true,
  };
}

async function emitToolCallOutcome(
  toolCall: BrewvaAgentEngineToolCall,
  result: BrewvaAgentEngineToolResult,
  isError: boolean,
  previousPhase: "classify" | "authorize" | "record",
  args: unknown,
  emit: BrewvaAgentEventSink,
): Promise<BrewvaAgentEngineToolResultMessage> {
  await emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError,
  });

  const toolResultMessage: BrewvaAgentEngineToolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now(),
  };
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
  await emitToolExecutionPhaseChange(toolCall, "cleanup", emit, previousPhase, args);
  return toolResultMessage;
}

async function emitToolExecutionPhaseChange(
  toolCall: BrewvaAgentEngineToolCall,
  phase: "classify" | "authorize" | "prepare" | "execute" | "record" | "cleanup",
  emit: BrewvaAgentEventSink,
  previousPhase?: "classify" | "authorize" | "prepare" | "execute" | "record",
  args?: unknown,
): Promise<void> {
  await emit({
    type: "tool_execution_phase_change",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    phase,
    previousPhase,
    args,
  });
}

function createFailureAssistantMessage(
  model: BrewvaRegisteredModel,
  errorMessage: string,
  stopReason: "error" | "aborted",
): BrewvaAgentEngineAssistantMessage {
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
