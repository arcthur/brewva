import {
  BrewvaEffect,
  fromAbortableBoundaryPromise,
  withBrewvaObservability,
} from "@brewva/brewva-effect";
import type {
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
  ProviderStreamError,
  ProviderRuntime,
  ResolvedFileContent,
} from "@brewva/brewva-provider-core/contracts";
import type { BrewvaRegisteredModel } from "../contracts/provider.js";
import { streamAssistantResponse } from "./assistant-stream.js";
import {
  BrewvaToolInvocationScope,
  BrewvaTurnScope,
  createTurnEventDispatcher,
  type BrewvaTurnRuntimeError,
  type BrewvaTurnEventDispatcher,
  type BrewvaTurnLoopEventSink,
} from "./effect-runtime.js";
import {
  applyPendingSteerToLastCommittedToolResult,
  appendSteerToToolResultMessage,
  dropPendingSteer,
  toolResultMessageContainsSteer,
} from "./steer.js";
import {
  emitToolCallMessageOutcome,
  executeToolCalls,
  type ToolCallOutcomeEnvelope,
} from "./tool-runner.js";
import type {
  BrewvaTurnLoopAfterToolCallContext,
  BrewvaTurnLoopBeforeToolCallContext,
  BrewvaTurnLoopContext,
  BrewvaTurnLoopMessage,
  BrewvaTurnLoopResolveRequestAuth,
  BrewvaTurnLoopStreamFunction,
  BrewvaTurnLoopThinkingBudgets,
  BrewvaTurnLoopThinkingLevel,
  BrewvaTurnLoopToolCall,
  BrewvaTurnLoopToolResult,
  BrewvaTurnLoopToolResultMessage,
  BrewvaTurnLoopTransport,
  BrewvaTurnLoopStopAfterToolResults,
} from "./types.js";

type BrewvaTurnLoopRuntimeError = BrewvaTurnRuntimeError | ProviderStreamError;
type PublicTurnRuntimeEffect<A> = BrewvaEffect.Effect<
  A,
  BrewvaTurnLoopRuntimeError,
  ProviderRuntime
>;
type InternalTurnRuntimeEffect<A> = BrewvaEffect.Effect<
  A,
  BrewvaTurnLoopRuntimeError,
  ProviderRuntime | BrewvaTurnScope
>;
type ToolScopedTurnRuntimeEffect<A> = BrewvaEffect.Effect<
  A,
  BrewvaTurnLoopRuntimeError,
  ProviderRuntime | BrewvaTurnScope | BrewvaToolInvocationScope
>;

export interface BrewvaTurnLoopConfig {
  model: BrewvaRegisteredModel;
  reasoning?: BrewvaTurnLoopThinkingLevel;
  sessionId?: string;
  cachePolicy?: ProviderCachePolicy;
  onCacheRender?: (
    render: ProviderCacheRenderResult,
    model: BrewvaRegisteredModel,
  ) => void | Promise<void>;
  onPayload?: (
    payload: unknown,
    model: BrewvaRegisteredModel,
    metadata?: ProviderPayloadMetadata,
  ) => unknown;
  transport: BrewvaTurnLoopTransport;
  thinkingBudgets?: BrewvaTurnLoopThinkingBudgets;
  maxRetryDelayMs?: number;
  resolveFile?: (
    part: import("./types.js").BrewvaTurnLoopFileContent,
    model: BrewvaRegisteredModel,
  ) => ResolvedFileContent | undefined;
  streamFn: BrewvaTurnLoopStreamFunction;
  beforeToolCall?: (
    context: BrewvaTurnLoopBeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  afterToolCall?: (
    context: BrewvaTurnLoopAfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<
    | {
        content?: BrewvaTurnLoopToolResult["content"];
        details?: unknown;
        isError?: boolean;
      }
    | undefined
  >;
  transformContext?: (
    messages: BrewvaTurnLoopMessage[],
    signal?: AbortSignal,
  ) => Promise<BrewvaTurnLoopMessage[]>;
  getQueuedMessagesEffect?: () => BrewvaEffect.Effect<
    BrewvaTurnLoopMessage[],
    BrewvaTurnRuntimeError,
    BrewvaTurnScope
  >;
  getFollowUpMessagesEffect?: () => BrewvaEffect.Effect<
    BrewvaTurnLoopMessage[],
    BrewvaTurnRuntimeError,
    BrewvaTurnScope
  >;
  consumePendingSteerEffect?: () => BrewvaEffect.Effect<
    string | undefined,
    BrewvaTurnRuntimeError,
    BrewvaTurnScope
  >;
  getCurrentContext?: () => Pick<BrewvaTurnLoopContext, "systemPrompt" | "tools">;
  resolveRequestAuth?: BrewvaTurnLoopResolveRequestAuth;
  toolExecution?: "parallel" | "sequential";
  shouldStopAfterToolResults?: BrewvaTurnLoopStopAfterToolResults;
}

export function runBrewvaTurnLoop(
  prompts: BrewvaTurnLoopMessage[],
  context: BrewvaTurnLoopContext,
  config: BrewvaTurnLoopConfig,
  emit: BrewvaTurnLoopEventSink,
  signal?: AbortSignal,
): PublicTurnRuntimeEffect<BrewvaTurnLoopMessage[]> {
  const observability = {
    sessionId: config.sessionId,
    model: config.model.id,
    provider: config.model.provider,
  };

  return BrewvaEffect.scoped(
    BrewvaEffect.gen(function* () {
      yield* BrewvaTurnScope;
      const dispatcher = yield* createTurnEventDispatcher(emit);
      const newMessages: BrewvaTurnLoopMessage[] = [...prompts];
      const currentContext: BrewvaTurnLoopContext = {
        ...context,
        messages: [...context.messages, ...prompts],
        tools: [...context.tools],
      };

      yield* dispatcher.emit({ type: "agent_start" });
      yield* dispatcher.emit({ type: "turn_start" });
      for (const prompt of prompts) {
        yield* dispatcher.emit({ type: "message_start", message: prompt });
        yield* dispatcher.emit({ type: "message_end", message: prompt });
      }

      yield* runLoop(currentContext, newMessages, config, signal, dispatcher);
      return newMessages;
    }),
  ).pipe(
    BrewvaEffect.provide(BrewvaTurnScope.layer({ sessionId: config.sessionId })),
    withBrewvaObservability("brewva.turn.loop", observability),
  );
}

function runLoop(
  currentContext: BrewvaTurnLoopContext,
  newMessages: BrewvaTurnLoopMessage[],
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  dispatcher: BrewvaTurnEventDispatcher,
): InternalTurnRuntimeEffect<void> {
  return BrewvaEffect.gen(function* () {
    let firstTurn = true;
    let pendingMessages = yield* getQueuedMessages(config, signal);

    while (true) {
      let hasMoreToolCalls = true;

      while (hasMoreToolCalls || pendingMessages.length > 0) {
        if (!firstTurn) {
          yield* dispatcher.emit({ type: "turn_start" });
        } else {
          firstTurn = false;
        }

        yield* applyPendingSteerToLastCommittedToolResult(
          currentContext,
          config,
          dispatcher,
          signal,
        );

        if (pendingMessages.length > 0) {
          for (const message of pendingMessages) {
            yield* dispatcher.emit({ type: "message_start", message });
            const messageEnd = yield* dispatcher.emit({
              type: "message_end",
              message,
            });
            const committedMessage =
              messageEnd?.type === "message_end" ? messageEnd.message : message;
            currentContext.messages.push(committedMessage);
            newMessages.push(committedMessage);
          }
          pendingMessages = [];
        }

        refreshCurrentContext(currentContext, config);
        const message = yield* streamAssistantResponse(currentContext, config, signal, dispatcher);
        newMessages.push(message);

        if (message.stopReason === "error" || message.stopReason === "aborted") {
          const dropReason = message.stopReason === "aborted" ? "aborted" : "failed";
          yield* dropPendingSteer(config, dispatcher, dropReason, signal);
          yield* dispatcher.emit({
            type: "turn_end",
            message,
            toolResults: [],
          });
          // turn_end listeners may enqueue steer after the pre-terminal drain.
          yield* dropPendingSteer(config, dispatcher, dropReason, signal);
          yield* dispatcher.emit({ type: "agent_end", messages: newMessages });
          return;
        }

        const toolCalls = message.content.filter(
          (content): content is BrewvaTurnLoopToolCall => content.type === "toolCall",
        );
        hasMoreToolCalls = toolCalls.length > 0;

        const toolResults: BrewvaTurnLoopToolResultMessage[] = [];
        if (hasMoreToolCalls) {
          const toolResultEnvelopes = yield* executeToolCalls(
            currentContext,
            message,
            toolCalls,
            config,
            signal,
            dispatcher,
          );
          const pendingSteer = yield* consumePendingSteer(config, signal);
          let appliedSteer:
            | {
                text: string;
                toolCallId: string;
                toolName: string;
              }
            | undefined;
          if (pendingSteer) {
            const target = toolResultEnvelopes[toolResultEnvelopes.length - 1];
            if (target) {
              appendSteerToToolResultMessage(target.message, pendingSteer);
              appliedSteer = {
                text: pendingSteer,
                toolCallId: target.toolCall.id,
                toolName: target.toolCall.name,
              };
            } else {
              yield* dispatcher.emit({
                type: "steer_dropped",
                text: pendingSteer,
                reason: "no_tool_boundary",
              });
            }
          }
          for (const outcome of toolResultEnvelopes) {
            const committedMessage = yield* emitToolCallMessageOutcome(outcome, dispatcher);
            toolResults.push(committedMessage);
            if (appliedSteer && outcome.toolCall.id === appliedSteer.toolCallId) {
              const steer = appliedSteer;
              if (toolResultMessageContainsSteer(committedMessage, steer.text)) {
                yield* withOutcomeToolInvocationScope(
                  outcome,
                  dispatcher.emit({
                    type: "steer_applied",
                    text: steer.text,
                    toolCallId: steer.toolCallId,
                    toolName: steer.toolName,
                    message: committedMessage,
                  }),
                );
              } else {
                yield* withOutcomeToolInvocationScope(
                  outcome,
                  dispatcher.emit({
                    type: "steer_dropped",
                    text: steer.text,
                    reason: "overwritten",
                  }),
                );
              }
              appliedSteer = undefined;
            }
          }
          for (const result of toolResults) {
            currentContext.messages.push(result);
            newMessages.push(result);
          }
        } else {
          yield* dropPendingSteer(config, dispatcher, "no_tool_boundary", signal);
        }

        yield* dispatcher.emit({ type: "turn_end", message, toolResults });
        if (!hasMoreToolCalls) {
          // turn_end listeners may enqueue steer when there will be no next provider turn.
          yield* dropPendingSteer(config, dispatcher, "no_tool_boundary", signal);
        }
        const shouldStopAfterToolResults =
          toolResults.length > 0 &&
          (yield* shouldStopAfterToolResultsEffect(config, toolResults, signal));
        if (shouldStopAfterToolResults) {
          yield* dropPendingSteer(config, dispatcher, "no_tool_boundary", signal);
          yield* dispatcher.emit({ type: "agent_end", messages: newMessages });
          return;
        }
        pendingMessages = yield* getQueuedMessages(config, signal);
      }

      const followUpMessages = yield* getFollowUpMessages(config, signal);
      if (followUpMessages.length > 0) {
        pendingMessages = followUpMessages;
        continue;
      }

      yield* dispatcher.emit({ type: "agent_end", messages: newMessages });
      return;
    }
  });
}

function getQueuedMessages(
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
): BrewvaEffect.Effect<BrewvaTurnLoopMessage[], BrewvaTurnRuntimeError, BrewvaTurnScope> {
  void signal;
  return config.getQueuedMessagesEffect?.() ?? BrewvaEffect.succeed([]);
}

function getFollowUpMessages(
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
): BrewvaEffect.Effect<BrewvaTurnLoopMessage[], BrewvaTurnRuntimeError, BrewvaTurnScope> {
  void signal;
  return config.getFollowUpMessagesEffect?.() ?? BrewvaEffect.succeed([]);
}

function consumePendingSteer(
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
): BrewvaEffect.Effect<string | undefined, BrewvaTurnRuntimeError, BrewvaTurnScope> {
  void signal;
  return config.consumePendingSteerEffect?.() ?? BrewvaEffect.succeed(undefined);
}

function shouldStopAfterToolResultsEffect(
  config: BrewvaTurnLoopConfig,
  toolResults: BrewvaTurnLoopToolResultMessage[],
  signal: AbortSignal | undefined,
): BrewvaEffect.Effect<boolean, BrewvaTurnRuntimeError> {
  return fromAbortableBoundaryPromise(async (abortSignal) => {
    const shouldStop = await config.shouldStopAfterToolResults?.(toolResults, abortSignal);
    return shouldStop === true;
  }, signal);
}

function withOutcomeToolInvocationScope<A>(
  outcome: ToolCallOutcomeEnvelope,
  effect: ToolScopedTurnRuntimeEffect<A>,
): InternalTurnRuntimeEffect<A> {
  return effect.pipe(BrewvaEffect.provide(BrewvaToolInvocationScope.layer(outcome.scope)));
}

function refreshCurrentContext(
  currentContext: BrewvaTurnLoopContext,
  config: BrewvaTurnLoopConfig,
): void {
  const latest = config.getCurrentContext?.();
  if (!latest) {
    return;
  }
  currentContext.systemPrompt = latest.systemPrompt;
  currentContext.tools = [...latest.tools];
}
