import type { BrewvaSessionMessageEntry } from "@brewva/brewva-substrate";

export const THINKING_LEVEL_SELECTED_EVENT_TYPE = "thinking_level_select";
export const SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE = "branch_summary_recorded";

export type StoredSessionMessage = BrewvaSessionMessageEntry["message"];

type StoredMessageUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeContent(content: unknown): { items: number; textChars: number } {
  if (!Array.isArray(content)) {
    return { items: 0, textChars: 0 };
  }

  let textChars = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") {
      textChars += text.length;
    }
  }
  return { items: content.length, textChars };
}

function isStoredSessionMessage(value: unknown): value is StoredSessionMessage {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    typeof (value as { timestamp?: unknown }).timestamp === "number"
  );
}

function readStoredMessageUsage(message: StoredSessionMessage): StoredMessageUsage | null {
  const usageCandidate = (message as { usage?: unknown }).usage;
  if (!isRecord(usageCandidate)) {
    return null;
  }
  const costCandidate = isRecord(usageCandidate.cost) ? usageCandidate.cost : null;
  return {
    input: typeof usageCandidate.input === "number" ? usageCandidate.input : undefined,
    output: typeof usageCandidate.output === "number" ? usageCandidate.output : undefined,
    cacheRead: typeof usageCandidate.cacheRead === "number" ? usageCandidate.cacheRead : undefined,
    cacheWrite:
      typeof usageCandidate.cacheWrite === "number" ? usageCandidate.cacheWrite : undefined,
    totalTokens:
      typeof usageCandidate.totalTokens === "number" ? usageCandidate.totalTokens : undefined,
    cost: costCandidate
      ? {
          total: typeof costCandidate.total === "number" ? costCandidate.total : undefined,
        }
      : undefined,
  };
}

export function summarizeTranscriptMessage(message: StoredSessionMessage): Record<string, unknown> {
  const content = summarizeContent((message as { content?: unknown }).content);
  const usage = readStoredMessageUsage(message);

  return {
    role: message.role ?? null,
    timestamp: message.timestamp,
    stopReason: (message as { stopReason?: unknown }).stopReason ?? null,
    provider: (message as { provider?: unknown }).provider ?? null,
    model: (message as { model?: unknown }).model ?? null,
    usage: usage
      ? {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          totalTokens: usage.totalTokens ?? 0,
          costTotal: usage.cost?.total ?? 0,
          cacheReadReported:
            typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead),
          cacheWriteReported:
            typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite),
        }
      : null,
    contentItems: content.items,
    contentTextChars: content.textChars,
  };
}

export function buildTranscriptMessagePayload(message: unknown): Record<string, unknown> {
  if (!isRecord(message) || typeof (message as { role?: unknown }).role !== "string") {
    return {};
  }
  const coerced = {
    ...message,
    role: message.role as string,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
  } as unknown as StoredSessionMessage;
  const storedMessage = structuredClone(coerced);
  return {
    ...summarizeTranscriptMessage(storedMessage),
    message: storedMessage,
  };
}

export function readTranscriptMessageFromPayload(payload: unknown): StoredSessionMessage | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const message = (payload as { message?: unknown }).message;
  return isStoredSessionMessage(message) ? structuredClone(message) : null;
}
