import type { BrewvaTurnLoopConfig, BrewvaTurnLoopEventSink } from "./loop.js";
import {
  prepareToolArguments,
  validateToolArguments,
  type BrewvaValidatedToolArguments,
} from "./tool-arguments.js";
import type {
  BrewvaTurnLoopAssistantMessage,
  BrewvaTurnLoopContext,
  BrewvaTurnLoopTool,
  BrewvaTurnLoopToolCall,
  BrewvaTurnLoopToolResult,
  BrewvaTurnLoopToolResultMessage,
} from "./types.js";

type PreparedToolCall = {
  kind: "prepared";
  toolCall: BrewvaTurnLoopToolCall;
  tool: BrewvaTurnLoopTool;
  args: BrewvaValidatedToolArguments;
  phase: "prepare";
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: BrewvaTurnLoopToolResult;
  isError: boolean;
  phase: "classify" | "authorize";
  args: unknown;
};

type ExecutedToolCallOutcome = {
  result: BrewvaTurnLoopToolResult;
  isError: boolean;
  phase: "execute";
};

export type ToolCallOutcomeEnvelope = {
  message: BrewvaTurnLoopToolResultMessage;
  toolCall: BrewvaTurnLoopToolCall;
  previousPhase: "classify" | "authorize" | "record";
  args: unknown;
};

export async function executeToolCalls(
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  toolCalls: BrewvaTurnLoopToolCall[],
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaTurnLoopEventSink,
): Promise<ToolCallOutcomeEnvelope[]> {
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
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  toolCalls: BrewvaTurnLoopToolCall[],
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaTurnLoopEventSink,
): Promise<ToolCallOutcomeEnvelope[]> {
  const results: ToolCallOutcomeEnvelope[] = [];
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
        await buildToolCallOutcome(
          toolCall,
          preparation.result,
          preparation.isError,
          preparation.phase,
          preparation.args,
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
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  toolCalls: BrewvaTurnLoopToolCall[],
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaTurnLoopEventSink,
): Promise<ToolCallOutcomeEnvelope[]> {
  const results: ToolCallOutcomeEnvelope[] = [];
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
        await buildToolCallOutcome(
          toolCall,
          preparation.result,
          preparation.isError,
          preparation.phase,
          preparation.args,
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
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  toolCall: BrewvaTurnLoopToolCall,
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaTurnLoopEventSink,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const tool = currentContext.tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
      phase: "classify",
      args: toolCall.arguments,
    };
  }

  try {
    const preparedToolCall = prepareToolArguments(tool, toolCall);
    const validatedArgs = validateToolArguments(tool, preparedToolCall);
    if (!validatedArgs.ok) {
      return {
        kind: "immediate",
        result: createErrorToolResult(validatedArgs.error),
        isError: true,
        phase: "classify",
        args: preparedToolCall.arguments,
      };
    }

    await emitToolExecutionPhaseChange(toolCall, "authorize", emit, "classify", validatedArgs.args);
    if (config.beforeToolCall) {
      try {
        const beforeResult = await config.beforeToolCall(
          {
            assistantMessage,
            toolCall,
            args: validatedArgs.args,
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
            args: validatedArgs.args,
          };
        }
      } catch (error) {
        return {
          kind: "immediate",
          result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
          isError: true,
          phase: "authorize",
          args: validatedArgs.args,
        };
      }
    }
    await emitToolExecutionPhaseChange(toolCall, "prepare", emit, "authorize", validatedArgs.args);
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs.args,
      phase: "prepare",
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
      phase: "classify",
      args: toolCall.arguments,
    };
  }
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: BrewvaTurnLoopEventSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<unknown>[] = [];
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
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaTurnLoopEventSink,
): Promise<ToolCallOutcomeEnvelope> {
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

  return buildToolCallOutcome(prepared.toolCall, result, isError, "record", prepared.args, emit);
}

function createErrorToolResult(message: string): BrewvaTurnLoopToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: undefined,
    isError: true,
  };
}

async function buildToolCallOutcome(
  toolCall: BrewvaTurnLoopToolCall,
  result: BrewvaTurnLoopToolResult,
  isError: boolean,
  previousPhase: "classify" | "authorize" | "record",
  args: unknown,
  emit: BrewvaTurnLoopEventSink,
): Promise<ToolCallOutcomeEnvelope> {
  await emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError,
  });

  const toolResultMessage: BrewvaTurnLoopToolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now(),
  };
  return {
    message: toolResultMessage,
    toolCall,
    previousPhase,
    args,
  };
}

export async function emitToolCallMessageOutcome(
  outcome: ToolCallOutcomeEnvelope,
  emit: BrewvaTurnLoopEventSink,
): Promise<BrewvaTurnLoopToolResultMessage> {
  await emit({ type: "message_start", message: outcome.message });
  const messageEnd = await emit({ type: "message_end", message: outcome.message });
  await emitToolExecutionPhaseChange(
    outcome.toolCall,
    "cleanup",
    emit,
    outcome.previousPhase,
    outcome.args,
  );
  if (messageEnd?.type !== "message_end") {
    return outcome.message;
  }
  if (messageEnd.message.role !== "toolResult") {
    throw new Error(
      `Tool result message_end transform must preserve role "toolResult" for ${outcome.toolCall.name}.`,
    );
  }
  return messageEnd.message;
}

async function emitToolExecutionPhaseChange(
  toolCall: BrewvaTurnLoopToolCall,
  phase: "classify" | "authorize" | "prepare" | "execute" | "record" | "cleanup",
  emit: BrewvaTurnLoopEventSink,
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
