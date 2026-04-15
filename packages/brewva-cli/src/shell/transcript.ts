import {
  extractMessageError,
  extractVisibleTextFromMessage,
  readMessageContentParts,
  readMessageRole,
  readToolResultMessage,
  type NormalizedMessageContentPart,
} from "../message-content.js";

export type CliShellTranscriptRole = "assistant" | "user" | "tool" | "custom" | "system";
export type CliTranscriptRenderMode = "stable" | "streaming";
export type CliShellTranscriptToolStatus = "pending" | "running" | "completed" | "error";

export interface CliShellTranscriptTextPart {
  type: "text";
  id: string;
  text: string;
  renderMode: CliTranscriptRenderMode;
}

export interface CliShellTranscriptReasoningPart {
  type: "reasoning";
  id: string;
  text: string;
  redacted?: boolean;
  renderMode: CliTranscriptRenderMode;
}

export interface CliShellTranscriptToolResultPayload {
  content: NormalizedMessageContentPart[];
  details?: unknown;
  isError?: boolean;
}

export interface CliShellTranscriptToolPart {
  type: "tool";
  id: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  phase?: string;
  status: CliShellTranscriptToolStatus;
  partialResult?: CliShellTranscriptToolResultPayload;
  result?: CliShellTranscriptToolResultPayload;
  renderMode: CliTranscriptRenderMode;
}

export type CliShellTranscriptPart =
  | CliShellTranscriptTextPart
  | CliShellTranscriptReasoningPart
  | CliShellTranscriptToolPart;

export interface CliShellTranscriptMessage {
  id: string;
  role: CliShellTranscriptRole;
  parts: CliShellTranscriptPart[];
  renderMode: CliTranscriptRenderMode;
}

export interface BuildTranscriptMessageOptions {
  id: string;
  renderMode?: CliTranscriptRenderMode;
  previousMessage?: CliShellTranscriptMessage | undefined;
}

export interface CliTranscriptToolExecutionUpdate {
  toolCallId: string;
  toolName?: string;
  args?: unknown;
  phase?: string;
  partialResult?: unknown;
  result?: unknown;
  status?: CliShellTranscriptToolStatus;
  renderMode?: CliTranscriptRenderMode;
  fallbackMessageId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeToolResultPayload(
  value: unknown,
): CliShellTranscriptToolResultPayload | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const content = Array.isArray(record.content)
    ? readMessageContentParts({ content: record.content })
    : [];
  return {
    content,
    details: record.details,
    isError: record.isError === true,
  };
}

function buildTextPart(
  id: string,
  text: string,
  renderMode: CliTranscriptRenderMode,
): CliShellTranscriptTextPart | null {
  if (text.length === 0) {
    return null;
  }
  return {
    type: "text",
    id,
    text,
    renderMode,
  };
}

function findToolPart(
  message: CliShellTranscriptMessage | undefined,
  toolCallId: string,
): CliShellTranscriptToolPart | undefined {
  return message?.parts.find(
    (part): part is CliShellTranscriptToolPart =>
      part.type === "tool" && part.toolCallId === toolCallId,
  );
}

function buildAssistantParts(
  messageId: string,
  renderMode: CliTranscriptRenderMode,
  previousMessage: CliShellTranscriptMessage | undefined,
  message: unknown,
): CliShellTranscriptPart[] {
  const parts: CliShellTranscriptPart[] = [];
  const normalized = readMessageContentParts(message);

  normalized.forEach((part, index) => {
    if (part.type === "text") {
      const textPart = buildTextPart(`${messageId}:text:${index}`, part.text, renderMode);
      if (textPart) {
        parts.push(textPart);
      }
      return;
    }

    if (part.type === "thinking") {
      if (part.thinking.length === 0) {
        return;
      }
      parts.push({
        type: "reasoning",
        id: `${messageId}:reasoning:${index}`,
        text: part.thinking,
        redacted: part.redacted,
        renderMode,
      });
      return;
    }

    if (part.type === "toolCall") {
      const previousToolPart = findToolPart(previousMessage, part.id);
      parts.push({
        type: "tool",
        id: `${messageId}:tool:${part.id}`,
        toolCallId: part.id,
        toolName: part.name,
        args: part.arguments,
        phase: previousToolPart?.phase,
        status: previousToolPart?.status ?? "pending",
        partialResult: previousToolPart?.partialResult,
        result: previousToolPart?.result,
        renderMode,
      });
    }
  });

  if (parts.length > 0) {
    return parts;
  }

  const fallbackText = extractVisibleTextFromMessage(message) || extractMessageError(message) || "";
  const fallbackPart = buildTextPart(`${messageId}:text:0`, fallbackText, renderMode);
  return fallbackPart ? [fallbackPart] : [];
}

function buildToolFallbackMessage(
  update: CliTranscriptToolExecutionUpdate,
): CliShellTranscriptMessage {
  const renderMode = update.renderMode ?? "stable";
  return {
    id: update.fallbackMessageId ?? `tool:${update.toolCallId}`,
    role: "tool",
    renderMode,
    parts: [
      {
        type: "tool",
        id: `${update.fallbackMessageId ?? `tool:${update.toolCallId}`}:tool:${update.toolCallId}`,
        toolCallId: update.toolCallId,
        toolName: update.toolName ?? "tool",
        args: update.args,
        phase: update.phase,
        status:
          update.status ??
          (normalizeToolResultPayload(update.result)?.isError === true
            ? "error"
            : update.result !== undefined
              ? "completed"
              : update.partialResult !== undefined
                ? "running"
                : "pending"),
        partialResult: normalizeToolResultPayload(update.partialResult),
        result: normalizeToolResultPayload(update.result),
        renderMode,
      },
    ],
  };
}

function findToolPartLocation(
  messages: readonly CliShellTranscriptMessage[],
  toolCallId: string,
):
  | {
      messageIndex: number;
      partIndex: number;
      message: CliShellTranscriptMessage;
      part: CliShellTranscriptToolPart;
    }
  | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message) {
      continue;
    }
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part?.type === "tool" && part.toolCallId === toolCallId) {
        return {
          messageIndex,
          partIndex,
          message,
          part,
        };
      }
    }
  }
  return undefined;
}

export function transcriptRoleLabel(role: CliShellTranscriptRole): string {
  switch (role) {
    case "assistant":
      return "Brewva";
    case "user":
      return "You";
    case "tool":
      return "Tool";
    case "custom":
      return "Note";
    default:
      return "System";
  }
}

export function buildTextTranscriptMessage(input: {
  id: string;
  role: CliShellTranscriptRole;
  text: string;
  renderMode?: CliTranscriptRenderMode;
}): CliShellTranscriptMessage | null {
  const renderMode = input.renderMode ?? "stable";
  const textPart = buildTextPart(`${input.id}:text:0`, input.text, renderMode);
  if (!textPart) {
    return null;
  }
  return {
    id: input.id,
    role: input.role,
    parts: [textPart],
    renderMode,
  };
}

export function buildTranscriptMessageFromMessage(
  message: unknown,
  options: BuildTranscriptMessageOptions,
): CliShellTranscriptMessage | null {
  const role = readMessageRole(message);
  const renderMode = options.renderMode ?? "stable";

  switch (role) {
    case "assistant": {
      const parts = buildAssistantParts(options.id, renderMode, options.previousMessage, message);
      return parts.length > 0
        ? {
            id: options.id,
            role: "assistant",
            parts,
            renderMode,
          }
        : null;
    }
    case "user":
    case "custom":
    case "system": {
      return buildTextTranscriptMessage({
        id: options.id,
        role,
        text: extractVisibleTextFromMessage(message),
        renderMode,
      });
    }
    default:
      return null;
  }
}

export function buildSeedTranscriptMessages(messages: unknown[]): CliShellTranscriptMessage[] {
  let transcript: CliShellTranscriptMessage[] = [];

  messages.forEach((message, index) => {
    const toolResult = readToolResultMessage(message);
    if (toolResult) {
      transcript = upsertToolExecutionIntoTranscriptMessages(transcript, {
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        result: toolResult,
        status: toolResult.isError ? "error" : "completed",
        renderMode: "stable",
        fallbackMessageId: `seed:tool:${index}`,
      });
      return;
    }

    const transcriptMessage = buildTranscriptMessageFromMessage(message, {
      id: `seed:${index}`,
      renderMode: "stable",
    });
    if (transcriptMessage) {
      transcript = [...transcript, transcriptMessage];
    }
  });

  return transcript;
}

export function upsertToolExecutionIntoTranscriptMessages(
  messages: readonly CliShellTranscriptMessage[],
  update: CliTranscriptToolExecutionUpdate,
): CliShellTranscriptMessage[] {
  const location = findToolPartLocation(messages, update.toolCallId);
  if (!location) {
    return [...messages, buildToolFallbackMessage(update)];
  }

  const renderMode = update.renderMode ?? location.message.renderMode;
  const nextPartialResult =
    update.partialResult !== undefined
      ? normalizeToolResultPayload(update.partialResult)
      : location.part.partialResult;
  const nextResult =
    update.result !== undefined ? normalizeToolResultPayload(update.result) : location.part.result;
  const inferredStatus =
    update.status ??
    (nextResult?.isError === true
      ? "error"
      : update.result !== undefined
        ? "completed"
        : update.partialResult !== undefined
          ? "running"
          : location.part.status);

  const nextPart: CliShellTranscriptToolPart = {
    ...location.part,
    toolName: update.toolName ?? location.part.toolName,
    args: update.args ?? location.part.args,
    phase: update.phase ?? location.part.phase,
    status: inferredStatus,
    partialResult: update.result !== undefined ? undefined : nextPartialResult,
    result: nextResult,
    renderMode,
  };

  const nextParts = [...location.message.parts];
  nextParts[location.partIndex] = nextPart;

  const nextMessage: CliShellTranscriptMessage = {
    ...location.message,
    parts: nextParts,
    renderMode,
  };

  const nextMessages = [...messages];
  nextMessages[location.messageIndex] = nextMessage;
  return nextMessages;
}
