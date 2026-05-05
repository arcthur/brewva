import type { AssistantMessage, StopReason } from "./message.js";
import type { ToolCall } from "./tool.js";

export type StreamingParseStatus = "incomplete" | "pending" | "likely_invalid";

export type AssistantMessageEventOf<TAssistantMessage, TToolCall, TStopReason extends string> =
  | { type: "start"; partial: TAssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: TAssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: TAssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: TAssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: TAssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: TAssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: TAssistantMessage }
  | {
      type: "toolcall_start";
      contentIndex: number;
      partial: TAssistantMessage;
      parseStatus?: StreamingParseStatus;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: TAssistantMessage;
      parseStatus?: StreamingParseStatus;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: TToolCall;
      partial: TAssistantMessage;
      parseStatus?: StreamingParseStatus;
    }
  | {
      type: "done";
      reason: Extract<TStopReason, "stop" | "length" | "toolUse">;
      message: TAssistantMessage;
    }
  | {
      type: "error";
      reason: Extract<TStopReason, "aborted" | "error">;
      error: TAssistantMessage;
    };

export type AssistantMessageEvent = AssistantMessageEventOf<AssistantMessage, ToolCall, StopReason>;
