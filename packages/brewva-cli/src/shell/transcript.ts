import type { ToolOutputDisplayView } from "@brewva/brewva-runtime";
import type { ToolExecutionPhase } from "@brewva/brewva-substrate";
import {
  extractMessageError,
  extractVisibleTextFromMessage,
  normalizeToolOutputDisplay,
  readMessageContentParts,
  readMessageRole,
  readToolResultMessage,
  type NormalizedMessageContentPart,
} from "../message-content.js";
import {
  buildTrustLoopToolProjection,
  type TrustLoopToolProjection,
} from "./trust-loop/projection.js";

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
  display?: ToolOutputDisplayView;
  isError?: boolean;
}

export interface CliShellTranscriptToolPart {
  type: "tool";
  id: string;
  toolCallId: string;
  toolName: string;
  trust: TrustLoopToolProjection;
  args?: unknown;
  phase?: ToolExecutionPhase;
  status: CliShellTranscriptToolStatus;
  partialResult?: CliShellTranscriptToolResultPayload;
  result?: CliShellTranscriptToolResultPayload;
  renderMode: CliTranscriptRenderMode;
}

function buildToolTrustProjection(input: {
  toolName: string;
  args?: unknown;
  phase?: ToolExecutionPhase;
  status: CliShellTranscriptToolStatus;
}): TrustLoopToolProjection {
  return buildTrustLoopToolProjection({
    toolName: input.toolName,
    args: input.args,
    executionPhase: input.phase,
    status: input.status,
  });
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
  phase?: ToolExecutionPhase;
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
  const display = normalizeToolOutputDisplay(record.display);
  return {
    content,
    details: record.details,
    ...(display ? { display } : {}),
    isError: record.isError === true,
  };
}

function toolPayloadIndicatesError(
  payload: CliShellTranscriptToolResultPayload | undefined,
): boolean {
  if (!payload) {
    return false;
  }
  return payload.isError === true || asRecord(payload.details)?.verdict === "fail";
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

function shouldDisplayMessage(message: unknown): boolean {
  return asRecord(message)?.display !== false;
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
      const toolName = part.name;
      const args = part.arguments;
      const phase = previousToolPart?.phase;
      const status = previousToolPart?.status ?? "pending";
      parts.push({
        type: "tool",
        id: `${messageId}:tool:${part.id}`,
        toolCallId: part.id,
        toolName,
        trust: buildToolTrustProjection({
          toolName,
          args,
          phase,
          status,
        }),
        args,
        phase,
        status,
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
  const partialResult = normalizeToolResultPayload(update.partialResult);
  const result = normalizeToolResultPayload(update.result);
  const toolName = update.toolName ?? "tool";
  const status =
    update.status ??
    (toolPayloadIndicatesError(result)
      ? "error"
      : update.result !== undefined
        ? "completed"
        : update.partialResult !== undefined
          ? "running"
          : "pending");
  return {
    id: update.fallbackMessageId ?? `tool:${update.toolCallId}`,
    role: "tool",
    renderMode,
    parts: [
      {
        type: "tool",
        id: `${update.fallbackMessageId ?? `tool:${update.toolCallId}`}:tool:${update.toolCallId}`,
        toolCallId: update.toolCallId,
        toolName,
        trust: buildToolTrustProjection({
          toolName,
          args: update.args,
          phase: update.phase,
          status,
        }),
        args: update.args,
        phase: update.phase,
        status,
        partialResult,
        result,
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
      if (!shouldDisplayMessage(message)) {
        return null;
      }
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
    case "system": {
      return buildTextTranscriptMessage({
        id: options.id,
        role,
        text: extractVisibleTextFromMessage(message),
        renderMode,
      });
    }
    case "custom": {
      if (!shouldDisplayMessage(message)) {
        return null;
      }
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
    (toolPayloadIndicatesError(nextResult)
      ? "error"
      : update.result !== undefined
        ? "completed"
        : update.partialResult !== undefined
          ? "running"
          : location.part.status);
  const nextToolName = update.toolName ?? location.part.toolName;
  const nextArgs = update.args ?? location.part.args;
  const nextPhase = update.phase ?? location.part.phase;

  const nextPart: CliShellTranscriptToolPart = {
    ...location.part,
    toolName: nextToolName,
    trust: buildToolTrustProjection({
      toolName: nextToolName,
      args: nextArgs,
      phase: nextPhase,
      status: inferredStatus,
    }),
    args: nextArgs,
    phase: nextPhase,
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
