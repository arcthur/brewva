import type { Content } from "@google/genai";
import type { StreamOptions } from "../../contracts/index.js";
import { convertTools, mapToolChoice } from "./shared.js";

export type GoogleThinkingLevel =
  | "THINKING_LEVEL_UNSPECIFIED"
  | "MINIMAL"
  | "LOW"
  | "MEDIUM"
  | "HIGH";

export interface GoogleThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: Exclude<GoogleThinkingLevel, "THINKING_LEVEL_UNSPECIFIED">;
}

export interface GoogleGeminiCliOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  requestId?: string;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
  projectId?: string;
  cacheControl?: {
    cachedContent?: {
      name: string;
    };
  };
}

export interface CloudCodeAssistRequest {
  project: string;
  model: string;
  request: {
    contents: Content[];
    sessionId?: string;
    cachedContent?: string;
    systemInstruction?: { role?: string; parts: { text: string }[] };
    generationConfig?: {
      maxOutputTokens?: number;
      temperature?: number;
      thinkingConfig?: GoogleThinkingConfig;
    };
    tools?: ReturnType<typeof convertTools>;
    toolConfig?: {
      functionCallingConfig: {
        mode: ReturnType<typeof mapToolChoice>;
      };
    };
  };
  requestType?: string;
  userAgent?: string;
  requestId?: string;
}

export interface CloudCodeAssistResponseChunk {
  response?: {
    candidates?: Array<{
      content?: {
        role: string;
        parts?: Array<{
          text?: string;
          thought?: boolean;
          thoughtSignature?: string;
          functionCall?: {
            name: string;
            args: Record<string, unknown>;
            id?: string;
          };
        }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      toolUsePromptTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
    };
    modelVersion?: string;
    responseId?: string;
  };
  traceId?: string;
}
