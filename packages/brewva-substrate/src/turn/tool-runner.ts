import {
  BrewvaBoundaryFailure,
  BrewvaCancelled,
  BrewvaEffect,
  BrewvaInterruptedError,
  fromAbortableBoundaryPromise,
} from "@brewva/brewva-effect";
import {
  BrewvaToolInvocationScope,
  BrewvaTurnScope,
  type BrewvaToolInvocationScopeShape,
  type BrewvaTurnEventDispatcher,
  type BrewvaTurnRuntimeError,
} from "./effect-runtime.js";
import type { BrewvaTurnLoopConfig } from "./loop.js";
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
  scope: BrewvaToolInvocationScopeShape;
};

type TurnRuntimeEffect<A> = BrewvaEffect.Effect<A, BrewvaTurnRuntimeError, BrewvaTurnScope>;
type ScopedToolRuntimeEffect<A> = BrewvaEffect.Effect<
  A,
  BrewvaTurnRuntimeError,
  BrewvaTurnScope | BrewvaToolInvocationScope
>;

function describeToolStageError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoverToolStageFailure<A>(
  error: BrewvaTurnRuntimeError,
  outcome: A,
): BrewvaEffect.Effect<A, BrewvaTurnRuntimeError> {
  if (error instanceof BrewvaCancelled || error instanceof BrewvaInterruptedError) {
    return BrewvaEffect.fail(error);
  }
  return BrewvaEffect.succeed(outcome);
}

function toolInvocationScopeFor(toolCall: BrewvaTurnLoopToolCall): BrewvaToolInvocationScopeShape {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  };
}

function withToolInvocationScope<A>(
  scope: BrewvaToolInvocationScopeShape,
  effect: ScopedToolRuntimeEffect<A>,
): TurnRuntimeEffect<A> {
  return effect.pipe(BrewvaEffect.provide(BrewvaToolInvocationScope.layer(scope)));
}

export function executeToolCalls(
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  toolCalls: BrewvaTurnLoopToolCall[],
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  dispatcher: BrewvaTurnEventDispatcher,
): TurnRuntimeEffect<ToolCallOutcomeEnvelope[]> {
  if (config.toolExecution === "sequential") {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      config,
      signal,
      dispatcher,
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    config,
    signal,
    dispatcher,
  );
}

function executeToolCallsSequential(
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  toolCalls: BrewvaTurnLoopToolCall[],
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  dispatcher: BrewvaTurnEventDispatcher,
): TurnRuntimeEffect<ToolCallOutcomeEnvelope[]> {
  return BrewvaEffect.gen(function* () {
    const results: ToolCallOutcomeEnvelope[] = [];
    for (const toolCall of toolCalls) {
      results.push(
        yield* withToolInvocationScope(
          toolInvocationScopeFor(toolCall),
          BrewvaEffect.gen(function* () {
            yield* dispatcher.emit({
              type: "tool_execution_start",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: toolCall.arguments,
            });
            yield* emitToolExecutionPhaseChange(
              toolCall,
              "classify",
              dispatcher,
              undefined,
              toolCall.arguments,
            );

            const preparation = yield* prepareToolCall(
              currentContext,
              assistantMessage,
              toolCall,
              config,
              signal,
              dispatcher,
            );
            if (preparation.kind === "immediate") {
              return yield* buildToolCallOutcome(
                toolCall,
                preparation.result,
                preparation.isError,
                preparation.phase,
                preparation.args,
                dispatcher,
              );
            }
            const executed = yield* executePreparedToolCall(preparation, signal, dispatcher);
            return yield* finalizeExecutedToolCall(
              currentContext,
              assistantMessage,
              preparation,
              executed,
              config,
              signal,
              dispatcher,
            );
          }),
        ),
      );
    }
    return results;
  });
}

function executeToolCallsParallel(
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  toolCalls: BrewvaTurnLoopToolCall[],
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  dispatcher: BrewvaTurnEventDispatcher,
): TurnRuntimeEffect<ToolCallOutcomeEnvelope[]> {
  return BrewvaEffect.gen(function* () {
    const results: ToolCallOutcomeEnvelope[] = [];
    const runnableCalls: PreparedToolCall[] = [];

    for (const toolCall of toolCalls) {
      const preparation = yield* withToolInvocationScope(
        toolInvocationScopeFor(toolCall),
        BrewvaEffect.gen(function* () {
          yield* dispatcher.emit({
            type: "tool_execution_start",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
          });
          yield* emitToolExecutionPhaseChange(
            toolCall,
            "classify",
            dispatcher,
            undefined,
            toolCall.arguments,
          );

          return yield* prepareToolCall(
            currentContext,
            assistantMessage,
            toolCall,
            config,
            signal,
            dispatcher,
          );
        }),
      );
      if (preparation.kind === "immediate") {
        results.push(
          yield* withToolInvocationScope(
            toolInvocationScopeFor(toolCall),
            buildToolCallOutcome(
              toolCall,
              preparation.result,
              preparation.isError,
              preparation.phase,
              preparation.args,
              dispatcher,
            ),
          ),
        );
        continue;
      }
      runnableCalls.push(preparation);
    }

    const executedCalls = yield* BrewvaEffect.all(
      runnableCalls.map((prepared) =>
        withToolInvocationScope(
          toolInvocationScopeFor(prepared.toolCall),
          executePreparedToolCall(prepared, signal, dispatcher),
        ),
      ),
      { concurrency: "unbounded" },
    );

    for (const [index, prepared] of runnableCalls.entries()) {
      const executed = executedCalls[index];
      if (!executed) continue;
      results.push(
        yield* withToolInvocationScope(
          toolInvocationScopeFor(prepared.toolCall),
          finalizeExecutedToolCall(
            currentContext,
            assistantMessage,
            prepared,
            executed,
            config,
            signal,
            dispatcher,
          ),
        ),
      );
    }

    return results;
  });
}

function prepareToolCall(
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  toolCall: BrewvaTurnLoopToolCall,
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  dispatcher: BrewvaTurnEventDispatcher,
): TurnRuntimeEffect<PreparedToolCall | ImmediateToolCallOutcome> {
  return BrewvaEffect.gen(function* () {
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

      return yield* BrewvaEffect.gen(function* () {
        yield* emitToolExecutionPhaseChange(
          toolCall,
          "authorize",
          dispatcher,
          "classify",
          validatedArgs.args,
        );
        if (config.beforeToolCall) {
          const beforeResult = yield* fromAbortableBoundaryPromise(
            (abortSignal) =>
              config.beforeToolCall?.(
                {
                  assistantMessage,
                  toolCall,
                  args: validatedArgs.args,
                  context: currentContext,
                },
                abortSignal,
              ) ?? Promise.resolve(undefined),
            signal,
          );
          if (beforeResult?.block) {
            return {
              kind: "immediate" as const,
              result: createErrorToolResult(beforeResult.reason ?? "Tool execution was blocked"),
              isError: true,
              phase: "authorize" as const,
              args: validatedArgs.args,
            };
          }
        }
        yield* emitToolExecutionPhaseChange(
          toolCall,
          "prepare",
          dispatcher,
          "authorize",
          validatedArgs.args,
        );
        return {
          kind: "prepared" as const,
          toolCall,
          tool,
          args: validatedArgs.args,
          phase: "prepare" as const,
        };
      }).pipe(
        BrewvaEffect.matchEffect({
          onSuccess: (prepared) => BrewvaEffect.succeed(prepared),
          onFailure: (error) =>
            recoverToolStageFailure(error, {
              kind: "immediate" as const,
              result: createErrorToolResult(describeToolStageError(error)),
              isError: true,
              phase: "authorize" as const,
              args: validatedArgs.args,
            }),
        }),
      );
    } catch (error) {
      return {
        kind: "immediate",
        result: createErrorToolResult(describeToolStageError(error)),
        isError: true,
        phase: "classify",
        args: toolCall.arguments,
      };
    }
  });
}

function executePreparedToolCall(
  prepared: PreparedToolCall,
  externalSignal: AbortSignal | undefined,
  dispatcher: BrewvaTurnEventDispatcher,
): ScopedToolRuntimeEffect<ExecutedToolCallOutcome> {
  const program = BrewvaEffect.gen(function* () {
    yield* BrewvaToolInvocationScope;
    const callbackScope = yield* dispatcher.captureScope();
    let activeExecutionSignal: AbortSignal | undefined;
    const emitUpdate = async (partialResult: BrewvaTurnLoopToolResult): Promise<void> => {
      await dispatcher.emitFromCallback(
        {
          type: "tool_execution_update",
          toolCallId: prepared.toolCall.id,
          toolName: prepared.toolCall.name,
          args: prepared.toolCall.arguments,
          partialResult,
        },
        {
          scope: callbackScope,
          runOptions: activeExecutionSignal ? { signal: activeExecutionSignal } : undefined,
        },
      );
    };

    yield* emitToolExecutionPhaseChange(
      prepared.toolCall,
      "execute",
      dispatcher,
      prepared.phase,
      prepared.args,
    );
    const result = yield* fromAbortableBoundaryPromise((signal) => {
      activeExecutionSignal = signal;
      return prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, emitUpdate);
    }, externalSignal);
    return { result, isError: result.isError === true, phase: "execute" as const };
  });

  return BrewvaEffect.scoped(program).pipe(
    BrewvaEffect.matchEffect({
      onSuccess: (executed) => BrewvaEffect.succeed(executed),
      onFailure: (error) =>
        recoverToolStageFailure(error, {
          result: createErrorToolResult(describeToolStageError(error)),
          isError: true,
          phase: "execute" as const,
        }),
    }),
  );
}

function finalizeExecutedToolCall(
  currentContext: BrewvaTurnLoopContext,
  assistantMessage: BrewvaTurnLoopAssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  dispatcher: BrewvaTurnEventDispatcher,
): ScopedToolRuntimeEffect<ToolCallOutcomeEnvelope> {
  return BrewvaEffect.gen(function* () {
    const finalized = yield* BrewvaEffect.gen(function* () {
      let result = executed.result;
      let isError = executed.isError;
      yield* emitToolExecutionPhaseChange(
        prepared.toolCall,
        "record",
        dispatcher,
        executed.phase,
        prepared.args,
      );

      if (config.afterToolCall) {
        const afterResult = yield* fromAbortableBoundaryPromise(
          (abortSignal) =>
            config.afterToolCall?.(
              {
                assistantMessage,
                toolCall: prepared.toolCall,
                args: prepared.args,
                result,
                isError,
                context: currentContext,
              },
              abortSignal,
            ) ?? Promise.resolve(undefined),
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

      return { result, isError };
    }).pipe(
      BrewvaEffect.matchEffect({
        onSuccess: (result) => BrewvaEffect.succeed(result),
        onFailure: (error) =>
          recoverToolStageFailure(error, {
            result: createErrorToolResult(describeToolStageError(error)),
            isError: true,
          }),
      }),
    );

    return yield* buildToolCallOutcome(
      prepared.toolCall,
      finalized.result,
      finalized.isError,
      "record",
      prepared.args,
      dispatcher,
    );
  });
}

function createErrorToolResult(message: string): BrewvaTurnLoopToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: undefined,
    isError: true,
  };
}

function buildToolCallOutcome(
  toolCall: BrewvaTurnLoopToolCall,
  result: BrewvaTurnLoopToolResult,
  isError: boolean,
  previousPhase: "classify" | "authorize" | "record",
  args: unknown,
  dispatcher: BrewvaTurnEventDispatcher,
): ScopedToolRuntimeEffect<ToolCallOutcomeEnvelope> {
  return BrewvaEffect.gen(function* () {
    const scope = yield* BrewvaToolInvocationScope;
    yield* dispatcher.emit({
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
      scope: {
        toolCallId: scope.toolCallId,
        toolName: scope.toolName,
      },
    };
  });
}

export function emitToolCallMessageOutcome(
  outcome: ToolCallOutcomeEnvelope,
  dispatcher: BrewvaTurnEventDispatcher,
): TurnRuntimeEffect<BrewvaTurnLoopToolResultMessage> {
  return withToolInvocationScope(
    outcome.scope,
    BrewvaEffect.gen(function* () {
      yield* dispatcher.emit({ type: "message_start", message: outcome.message });
      const messageEnd = yield* dispatcher.emit({ type: "message_end", message: outcome.message });
      yield* emitToolExecutionPhaseChange(
        outcome.toolCall,
        "cleanup",
        dispatcher,
        outcome.previousPhase,
        outcome.args,
      );
      if (messageEnd?.type !== "message_end") {
        return outcome.message;
      }
      if (messageEnd.message.role !== "toolResult") {
        return yield* BrewvaEffect.fail(
          new BrewvaBoundaryFailure({
            message: `Tool result message_end transform must preserve role "toolResult" for ${outcome.toolCall.name}.`,
          }),
        );
      }
      return messageEnd.message;
    }),
  );
}

function emitToolExecutionPhaseChange(
  toolCall: BrewvaTurnLoopToolCall,
  phase: "classify" | "authorize" | "prepare" | "execute" | "record" | "cleanup",
  dispatcher: BrewvaTurnEventDispatcher,
  previousPhase?: "classify" | "authorize" | "prepare" | "execute" | "record",
  args?: unknown,
): TurnRuntimeEffect<void> {
  return dispatcher
    .emit({
      type: "tool_execution_phase_change",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      phase,
      previousPhase,
      args,
    })
    .pipe(BrewvaEffect.asVoid);
}
