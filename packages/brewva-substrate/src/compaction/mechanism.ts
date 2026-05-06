import { estimateStructuredTokenCount } from "@brewva/brewva-token-estimation";
import type {
  BrewvaTurnLoopCompactionSummaryMessage,
  BrewvaTurnLoopMessage,
} from "../turn/types.js";

export const BREWVA_COMPACTION_SUMMARY_HEADER = "[CompactSummary]";
export const BREWVA_COMPACTION_DEFAULT_LINE =
  "- Preserve the current task state and latest verified evidence.";

export interface BrewvaCompactionSummaryOptions {
  maxLines?: number;
  maxLineChars?: number;
}

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

export interface BrewvaContextCompactionUsage {
  tokens: number | null;
  contextWindow: number;
  percent?: number | null;
}

export interface BrewvaContextCompactionThresholdOptions {
  thresholdRatio?: number;
  minTokens?: number;
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

const DEFAULT_SUMMARY_MAX_LINES = 8;
const DEFAULT_SUMMARY_MAX_CHARS = 220;
const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8;

function normalizeSummaryText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function summarizeUnknownMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return normalizeSummaryText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const fragments: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as { type?: unknown; text?: unknown; name?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      fragments.push(record.text);
      continue;
    }
    if (record.type === "toolCall" && typeof record.name === "string") {
      fragments.push(`[toolCall:${record.name}]`);
    }
  }
  return normalizeSummaryText(fragments.join(" "));
}

export function summarizeBrewvaCompactionMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const record = message as {
    role?: unknown;
    content?: unknown;
    toolName?: unknown;
    customType?: unknown;
    summary?: unknown;
    errorMessage?: unknown;
  };

  if (record.role === "branchSummary" && typeof record.summary === "string") {
    return `branchSummary: ${normalizeSummaryText(record.summary)}`;
  }
  if (record.role === "compactionSummary" && typeof record.summary === "string") {
    return `compactionSummary: ${normalizeSummaryText(record.summary)}`;
  }
  if (record.role === "toolResult") {
    const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
    const body = summarizeUnknownMessageContent(record.content);
    return body.length > 0 ? `toolResult(${toolName}): ${body}` : `toolResult(${toolName})`;
  }
  if (record.role === "custom") {
    const customType = typeof record.customType === "string" ? record.customType : "custom";
    const body = summarizeUnknownMessageContent(record.content);
    return body.length > 0 ? `custom(${customType}): ${body}` : `custom(${customType})`;
  }
  if (typeof record.role === "string") {
    const body = summarizeUnknownMessageContent(record.content);
    if (body.length > 0) {
      return `${record.role}: ${body}`;
    }
    if (typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0) {
      return `${record.role}: ${record.errorMessage.trim()}`;
    }
    return record.role;
  }
  return null;
}

export function serializeBrewvaCompactionConversation(messages: readonly unknown[]): string {
  return messages
    .map((message) => summarizeBrewvaCompactionMessage(message) ?? "")
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function trimCompactionSummaryLine(line: string, maxLineChars: number): string {
  if (line.length <= maxLineChars) {
    return line;
  }
  return `${line.slice(0, maxLineChars - 1).trimEnd()}…`;
}

export function buildBrewvaDeterministicCompactionSummary(
  messages: readonly unknown[],
  options: BrewvaCompactionSummaryOptions = {},
): string {
  const maxLines = Math.max(1, Math.trunc(options.maxLines ?? DEFAULT_SUMMARY_MAX_LINES));
  const maxLineChars = Math.max(16, Math.trunc(options.maxLineChars ?? DEFAULT_SUMMARY_MAX_CHARS));
  const summarized = messages
    .map((message) => summarizeBrewvaCompactionMessage(message))
    .filter((line): line is string => typeof line === "string" && line.length > 0);
  const selected = summarized
    .slice(-maxLines)
    .map((line) => trimCompactionSummaryLine(line, maxLineChars));
  const lines = [BREWVA_COMPACTION_SUMMARY_HEADER];

  if (selected.length === 0) {
    lines.push(BREWVA_COMPACTION_DEFAULT_LINE);
  } else {
    for (const line of selected) {
      lines.push(`- ${line}`);
    }
  }
  return lines.join("\n");
}

export function estimateBrewvaCompactionTokens(messages: readonly unknown[]): number {
  return estimateStructuredTokenCount(serializeBrewvaCompactionConversation(messages));
}

export function shouldCompactBrewvaContext(
  usage: BrewvaContextCompactionUsage | undefined,
  options: BrewvaContextCompactionThresholdOptions = {},
): boolean {
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) {
    return false;
  }

  const thresholdRatio = options.thresholdRatio ?? DEFAULT_COMPACTION_THRESHOLD_RATIO;
  if (options.minTokens !== undefined && usage.tokens < options.minTokens) {
    return false;
  }

  return usage.tokens / usage.contextWindow >= thresholdRatio;
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
      ((message: unknown) =>
        estimateStructuredTokenCount(summarizeBrewvaCompactionMessage(message) ?? ""));
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
