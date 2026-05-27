import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { StreamOptions, Usage } from "../../contracts/index.js";

export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  include?: ResponseCreateParamsStreaming["include"];
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

export interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
}

export interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
}
