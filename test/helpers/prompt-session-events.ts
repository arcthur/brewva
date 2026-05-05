import type {
  BrewvaPromptAssistantMessageEvent,
  BrewvaPromptSessionEvent,
  BrewvaPromptToolCall,
} from "@brewva/brewva-substrate";

export function createPromptMessageUpdateEvent(input: {
  message?: unknown;
  assistantMessageEvent: BrewvaPromptAssistantMessageEvent;
}): Extract<BrewvaPromptSessionEvent, { type: "message_update" }> {
  return {
    type: "message_update",
    message: input.message,
    assistantMessageEvent: input.assistantMessageEvent,
  };
}

export function createPromptMessageEndEvent(
  message: unknown,
): Extract<BrewvaPromptSessionEvent, { type: "message_end" }> {
  return {
    type: "message_end",
    message,
  };
}

export function createTextDeltaAssistantEvent(input: {
  delta: string;
  partial: unknown;
  contentIndex?: number;
}): Extract<BrewvaPromptAssistantMessageEvent, { type: "text_delta" }> {
  return {
    type: "text_delta",
    contentIndex: input.contentIndex ?? 0,
    delta: input.delta,
    partial: input.partial,
  };
}

export function createToolcallDeltaAssistantEvent(input: {
  delta: string;
  partial: unknown;
  parseStatus?: "incomplete" | "pending" | "likely_invalid";
  contentIndex?: number;
}): Extract<BrewvaPromptAssistantMessageEvent, { type: "toolcall_delta" }> {
  return {
    type: "toolcall_delta",
    contentIndex: input.contentIndex ?? 0,
    delta: input.delta,
    partial: input.partial,
    parseStatus: input.parseStatus,
  };
}

export function createToolcallEndAssistantEvent(input: {
  toolCall: BrewvaPromptToolCall;
  partial: unknown;
  parseStatus?: "incomplete" | "pending" | "likely_invalid";
  contentIndex?: number;
}): Extract<BrewvaPromptAssistantMessageEvent, { type: "toolcall_end" }> {
  return {
    type: "toolcall_end",
    contentIndex: input.contentIndex ?? 0,
    toolCall: input.toolCall,
    partial: input.partial,
    parseStatus: input.parseStatus,
  };
}
