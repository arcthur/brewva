import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAIOptions as SDKGoogleGenAIOptions,
} from "@google/genai";
import type { StreamOptions } from "../../contracts/index.js";
import type { GoogleThinkingLevel } from "../_shared/google/contract.js";

export type GoogleGenAIClient = {
  models: {
    generateContentStream(
      params: GenerateContentParameters,
    ): AsyncIterable<GenerateContentResponse> | PromiseLike<AsyncIterable<GenerateContentResponse>>;
  };
};

export interface GoogleGenAIOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
  cacheControl?: {
    cachedContent?: {
      name: string;
      ttlSeconds?: number;
    };
  };
  client?: GoogleGenAIClient;
  enterprise?: boolean;
  project?: string;
  location?: string;
  apiVersion?: string;
  googleAuthOptions?: SDKGoogleGenAIOptions["googleAuthOptions"];
  httpOptions?: SDKGoogleGenAIOptions["httpOptions"];
}
