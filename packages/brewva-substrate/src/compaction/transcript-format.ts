import { estimateStructuredTokenCount } from "@brewva/brewva-token-estimation";

const COMPACTION_TOOL_RESULT_MAX_CHARS = 2_000;
const COMPACTION_IMAGE_PLACEHOLDER_CHARS = 4_800;

function normalizeSummaryText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)} [... ${truncatedChars} more characters truncated]`;
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
      continue;
    }
    if (record.type === "image" || record.type === "image_url" || record.type === "input_image") {
      fragments.push(`[image ~${COMPACTION_IMAGE_PLACEHOLDER_CHARS} chars]`);
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
    if (body.length === 0) {
      return `toolResult(${toolName})`;
    }
    return `toolResult(${toolName}): ${truncateForSummary(body, COMPACTION_TOOL_RESULT_MAX_CHARS)}`;
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

export function estimateBrewvaCompactionTokens(messages: readonly unknown[]): number {
  return estimateStructuredTokenCount(serializeBrewvaCompactionConversation(messages));
}

export function estimateBrewvaCompactionMessageTokens(message: unknown): number {
  return estimateStructuredTokenCount(summarizeBrewvaCompactionMessage(message) ?? "");
}
