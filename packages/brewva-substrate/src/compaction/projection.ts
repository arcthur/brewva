import type {
  BrewvaTurnLoopCompactionSummaryMessage,
  BrewvaTurnLoopMessage,
} from "../turn/types.js";
import {
  estimateBrewvaCompactionMessageTokens,
  estimateBrewvaCompactionTokens,
} from "./transcript-format.js";

export interface BrewvaCompactionCutPointOptions {
  keepLastMessages?: number;
  maxKeptTokens?: number;
  estimateMessageTokens?: (message: unknown, index: number) => number;
}

export interface BrewvaCompactionCutPoint {
  firstKeptIndex: number;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
}

export interface CreateBrewvaCompactionSummaryMessageInput {
  summary: string;
  tokensBefore: number;
  timestamp?: number;
  display?: boolean;
  excludeFromContext?: boolean;
  details?: unknown;
}

export interface ProjectBrewvaCompactionMessagesInput extends CreateBrewvaCompactionSummaryMessageInput {
  firstKeptIndex: number;
}

export function findBrewvaCompactionCutPoint(
  messages: readonly unknown[],
  options: BrewvaCompactionCutPointOptions = {},
): BrewvaCompactionCutPoint | null {
  if (messages.length < 2) {
    return null;
  }

  const keepLastMessages = Math.min(
    messages.length,
    Math.max(1, Math.trunc(options.keepLastMessages ?? 1)),
  );
  let firstKeptIndex = messages.length - keepLastMessages;

  if (options.maxKeptTokens !== undefined) {
    const maxKeptTokens = Math.max(0, options.maxKeptTokens);
    const estimateMessageTokens =
      options.estimateMessageTokens ??
      ((message: unknown) => estimateBrewvaCompactionMessageTokens(message));
    let keptTokens = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const nextTokens = estimateMessageTokens(messages[index], index);
      const mustKeep = index >= messages.length - keepLastMessages;
      if (!mustKeep && keptTokens + nextTokens > maxKeptTokens) {
        break;
      }
      keptTokens += nextTokens;
      firstKeptIndex = index;
    }
  }

  if (firstKeptIndex <= 0) {
    return null;
  }

  return {
    firstKeptIndex,
    messagesBefore: firstKeptIndex,
    messagesAfter: messages.length - firstKeptIndex,
    tokensBefore: estimateBrewvaCompactionTokens(messages.slice(0, firstKeptIndex)),
  };
}

export function createBrewvaCompactionSummaryMessage(
  input: CreateBrewvaCompactionSummaryMessageInput,
): BrewvaTurnLoopCompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary: input.summary,
    tokensBefore: input.tokensBefore,
    timestamp: input.timestamp ?? Date.now(),
    ...(input.display !== undefined ? { display: input.display } : {}),
    ...(input.excludeFromContext !== undefined
      ? { excludeFromContext: input.excludeFromContext }
      : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}

export function projectBrewvaCompactionMessages(
  messages: readonly BrewvaTurnLoopMessage[],
  input: ProjectBrewvaCompactionMessagesInput,
): BrewvaTurnLoopMessage[] {
  const firstKeptIndex = Math.min(messages.length, Math.max(0, Math.trunc(input.firstKeptIndex)));
  return [createBrewvaCompactionSummaryMessage(input), ...messages.slice(firstKeptIndex)];
}
