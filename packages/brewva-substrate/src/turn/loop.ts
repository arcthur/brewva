import type {
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
  ResolvedFileContent,
} from "@brewva/brewva-provider-core/contracts";
import type { BrewvaRegisteredModel } from "../contracts/provider.js";
import { streamAssistantResponse } from "./assistant-stream.js";
import {
  applyPendingSteerToLastCommittedToolResult,
  appendSteerToToolResultMessage,
  dropPendingSteer,
  toolResultMessageContainsSteer,
} from "./steer.js";
import { emitToolCallMessageOutcome, executeToolCalls } from "./tool-runner.js";
import type {
  BrewvaTurnLoopAfterToolCallContext,
  BrewvaTurnLoopBeforeToolCallContext,
  BrewvaTurnLoopContext,
  BrewvaTurnLoopEvent,
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

export type BrewvaTurnLoopEventSink = (
  event: BrewvaTurnLoopEvent,
) => Promise<BrewvaTurnLoopEvent | void> | BrewvaTurnLoopEvent | void;

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
  ) => Promise<unknown>;
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
  getQueuedMessages?: () => Promise<BrewvaTurnLoopMessage[]>;
  getFollowUpMessages?: () => Promise<BrewvaTurnLoopMessage[]>;
  consumePendingSteer?: () => Promise<string | undefined>;
  getCurrentContext?: () => Pick<BrewvaTurnLoopContext, "systemPrompt" | "tools">;
  resolveRequestAuth?: BrewvaTurnLoopResolveRequestAuth;
  toolExecution?: "parallel" | "sequential";
  shouldStopAfterToolResults?: BrewvaTurnLoopStopAfterToolResults;
}

export async function runBrewvaTurnLoop(
  prompts: BrewvaTurnLoopMessage[],
  context: BrewvaTurnLoopContext,
  config: BrewvaTurnLoopConfig,
  emit: BrewvaTurnLoopEventSink,
  signal?: AbortSignal,
): Promise<BrewvaTurnLoopMessage[]> {
  const newMessages: BrewvaTurnLoopMessage[] = [...prompts];
  const currentContext: BrewvaTurnLoopContext = {
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
  currentContext: BrewvaTurnLoopContext,
  newMessages: BrewvaTurnLoopMessage[],
  config: BrewvaTurnLoopConfig,
  signal: AbortSignal | undefined,
  emit: BrewvaTurnLoopEventSink,
): Promise<void> {
  let firstTurn = true;
  let pendingMessages = (await config.getQueuedMessages?.()) ?? [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      await applyPendingSteerToLastCommittedToolResult(currentContext, config, emit);

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          const messageEnd = await emit({ type: "message_end", message });
          const committedMessage =
            messageEnd?.type === "message_end" ? messageEnd.message : message;
          currentContext.messages.push(committedMessage);
          newMessages.push(committedMessage);
        }
        pendingMessages = [];
      }

      refreshCurrentContext(currentContext, config);
      const message = await streamAssistantResponse(currentContext, config, signal, emit);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        const dropReason = message.stopReason === "aborted" ? "aborted" : "failed";
        await dropPendingSteer(config, emit, dropReason);
        await emit({ type: "turn_end", message, toolResults: [] });
        // turn_end listeners may enqueue steer after the pre-terminal drain.
        await dropPendingSteer(config, emit, dropReason);
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const toolCalls = message.content.filter(
        (content): content is BrewvaTurnLoopToolCall => content.type === "toolCall",
      );
      hasMoreToolCalls = toolCalls.length > 0;

      const toolResults: BrewvaTurnLoopToolResultMessage[] = [];
      if (hasMoreToolCalls) {
        const toolResultEnvelopes = await executeToolCalls(
          currentContext,
          message,
          toolCalls,
          config,
          signal,
          emit,
        );
        const pendingSteer = await config.consumePendingSteer?.();
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
            await emit({
              type: "steer_dropped",
              text: pendingSteer,
              reason: "no_tool_boundary",
            });
          }
        }
        for (const outcome of toolResultEnvelopes) {
          const committedMessage = await emitToolCallMessageOutcome(outcome, emit);
          toolResults.push(committedMessage);
          if (appliedSteer && outcome.toolCall.id === appliedSteer.toolCallId) {
            if (toolResultMessageContainsSteer(committedMessage, appliedSteer.text)) {
              await emit({
                type: "steer_applied",
                text: appliedSteer.text,
                toolCallId: appliedSteer.toolCallId,
                toolName: appliedSteer.toolName,
                message: committedMessage,
              });
            } else {
              await emit({
                type: "steer_dropped",
                text: appliedSteer.text,
                reason: "overwritten",
              });
            }
            appliedSteer = undefined;
          }
        }
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      } else {
        await dropPendingSteer(config, emit, "no_tool_boundary");
      }

      await emit({ type: "turn_end", message, toolResults });
      if (!hasMoreToolCalls) {
        // turn_end listeners may enqueue steer when there will be no next provider turn.
        await dropPendingSteer(config, emit, "no_tool_boundary");
      }
      const shouldStopAfterToolResults =
        toolResults.length > 0 && (await config.shouldStopAfterToolResults?.(toolResults)) === true;
      if (shouldStopAfterToolResults) {
        await dropPendingSteer(config, emit, "no_tool_boundary");
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }
      pendingMessages = (await config.getQueuedMessages?.()) ?? [];
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    await emit({ type: "agent_end", messages: newMessages });
    return;
  }
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
