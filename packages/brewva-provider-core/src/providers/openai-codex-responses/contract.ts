import type { Tool as OpenAITool, ResponseInput } from "openai/resources/responses/responses.js";
import type { StreamOptions } from "../../contracts/index.js";

export interface OpenAICodexResponsesOptions extends StreamOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  textVerbosity?: "low" | "medium" | "high";
  previousResponseId?: string;
}

export type CodexResponseStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "queued"
  | "in_progress";

export interface RequestBody {
  model: string;
  store?: boolean;
  stream?: boolean;
  instructions?: string;
  input?: ResponseInput;
  tools?: OpenAITool[];
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  text?: { verbosity?: string };
  include?: string[];
  prompt_cache_key?: string;
  previous_response_id?: string;
  [key: string]: unknown;
}

export type ResponseInputItem = ResponseInput[number];

export interface CodexLastResponseState {
  responseId: string;
  outputItems: ResponseInput;
}

export interface CodexContinuationState {
  model: string;
  previousRequest: RequestBody;
  lastResponse: CodexLastResponseState;
}
