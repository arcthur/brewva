function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface NormalizedMessageTextPart {
  type: "text";
  text: string;
}

export interface NormalizedMessageThinkingPart {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface NormalizedMessageToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface NormalizedMessageImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

export type NormalizedMessageContentPart =
  | NormalizedMessageTextPart
  | NormalizedMessageThinkingPart
  | NormalizedMessageToolCallPart
  | NormalizedMessageImagePart;

export interface NormalizedToolResultMessage {
  toolCallId: string;
  toolName: string;
  content: NormalizedMessageContentPart[];
  details?: unknown;
  isError: boolean;
}

export function readMessageRole(message: unknown): string | undefined {
  const record = asRecord(message);
  return typeof record?.role === "string" ? record.role : undefined;
}

export function readMessageStopReason(message: unknown): string | undefined {
  const record = asRecord(message);
  return typeof record?.stopReason === "string" ? record.stopReason : undefined;
}

export function extractMessageError(message: unknown): string | undefined {
  const record = asRecord(message);
  return typeof record?.errorMessage === "string" && record.errorMessage.trim().length > 0
    ? record.errorMessage.trim()
    : undefined;
}

function normalizeMessageContentPart(part: unknown): NormalizedMessageContentPart | null {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  const record = asRecord(part);
  if (!record) {
    return null;
  }

  if (record.type === "text" && typeof record.text === "string") {
    return {
      type: "text",
      text: record.text,
    };
  }

  if (record.type === "thinking" && typeof record.thinking === "string") {
    return {
      type: "thinking",
      thinking: record.thinking,
      redacted: record.redacted === true,
    };
  }

  if (
    record.type === "toolCall" &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    record.arguments &&
    typeof record.arguments === "object" &&
    !Array.isArray(record.arguments)
  ) {
    return {
      type: "toolCall",
      id: record.id,
      name: record.name,
      arguments: record.arguments as Record<string, unknown>,
      thoughtSignature: readString(record.thoughtSignature),
    };
  }

  if (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  ) {
    return {
      type: "image",
      data: record.data,
      mimeType: record.mimeType,
    };
  }

  if (typeof record.text === "string") {
    return {
      type: "text",
      text: record.text,
    };
  }

  const nestedContent = asRecord(record.content);
  if (nestedContent && typeof nestedContent.text === "string") {
    return {
      type: "text",
      text: nestedContent.text,
    };
  }

  return null;
}

export function readMessageContentParts(message: unknown): NormalizedMessageContentPart[] {
  const record = asRecord(message);
  if (!record) {
    return [];
  }

  const directContent = record.content;
  if (typeof directContent === "string") {
    return [{ type: "text", text: directContent }];
  }
  if (typeof record.text === "string") {
    return [{ type: "text", text: record.text }];
  }
  if (!Array.isArray(directContent)) {
    return [];
  }

  const parts: NormalizedMessageContentPart[] = [];
  for (const part of directContent) {
    const normalized = normalizeMessageContentPart(part);
    if (normalized) {
      parts.push(normalized);
    }
  }

  return parts;
}

export function readToolResultMessage(message: unknown): NormalizedToolResultMessage | null {
  const record = asRecord(message);
  if (!record || record.role !== "toolResult") {
    return null;
  }

  if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") {
    return null;
  }

  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    content: readMessageContentParts(message),
    details: record.details,
    isError: record.isError === true,
  };
}

export function readAssistantMessageEventPartial(assistantMessageEvent: unknown): unknown {
  const record = asRecord(assistantMessageEvent);
  return record?.partial;
}

export function extractVisibleTextFromMessage(message: unknown): string {
  const segments = readMessageContentParts(message)
    .filter((part): part is NormalizedMessageTextPart => part.type === "text")
    .map((part) => part.text);
  const visibleText = segments.join("");
  if (visibleText.length > 0) {
    return visibleText;
  }
  return extractMessageError(message) ?? "";
}
