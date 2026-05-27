import {
  ThinkingLevel as SDKThinkingLevel,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type ThinkingConfig as SDKThinkingConfig,
} from "@google/genai";
import type { Context, Model } from "../../contracts/index.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import type { GoogleThinkingConfig, GoogleThinkingLevel } from "../_shared/google/contract.js";
import { convertMessages, convertTools, mapToolChoice } from "../_shared/google/messages.js";
import {
  buildGoogleThinkingLevelConfig,
  getDisabledThinkingConfig,
  isGemini3Model,
} from "../_shared/google/thinking.js";
import type { GoogleGenAIOptions } from "./contract.js";

function toSDKThinkingLevel(level: GoogleThinkingLevel): SDKThinkingLevel {
  switch (level) {
    case "THINKING_LEVEL_UNSPECIFIED":
      return SDKThinkingLevel.THINKING_LEVEL_UNSPECIFIED;
    case "MINIMAL":
      return SDKThinkingLevel.MINIMAL;
    case "LOW":
      return SDKThinkingLevel.LOW;
    case "MEDIUM":
      return SDKThinkingLevel.MEDIUM;
    case "HIGH":
      return SDKThinkingLevel.HIGH;
  }
}

function toSDKThinkingConfig(
  config: GoogleThinkingConfig,
  options: { includeThoughts?: boolean } = {},
): SDKThinkingConfig {
  return {
    ...(config.thinkingBudget !== undefined ? { thinkingBudget: config.thinkingBudget } : {}),
    ...(config.thinkingLevel ? { thinkingLevel: toSDKThinkingLevel(config.thinkingLevel) } : {}),
    ...(options.includeThoughts !== undefined ? { includeThoughts: options.includeThoughts } : {}),
  };
}

export function buildGoogleGenAIRequest(
  model: Model<"google-genai">,
  context: Context,
  options: GoogleGenAIOptions = {},
): GenerateContentParameters {
  const config: GenerateContentConfig = {};

  if (context.systemPrompt) {
    config.systemInstruction = {
      parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
    };
  }

  if (options.maxTokens !== undefined) {
    config.maxOutputTokens = options.maxTokens;
  }

  if (options.temperature !== undefined) {
    config.temperature = options.temperature;
  }

  if (options.signal) {
    config.abortSignal = options.signal;
  }

  if (options.cacheControl?.cachedContent?.name) {
    config.cachedContent = options.cacheControl.cachedContent.name;
  }

  if (context.tools && context.tools.length > 0) {
    config.tools = convertTools(context.tools) as GenerateContentConfig["tools"];
  }

  if (options.toolChoice) {
    config.toolConfig = {
      functionCallingConfig: {
        mode: mapToolChoice(options.toolChoice),
      },
    };
  }

  if (model.reasoning) {
    const thinkingEnabled = options.thinking?.enabled === true;
    if (thinkingEnabled) {
      if (options.thinking?.level) {
        config.thinkingConfig = toSDKThinkingConfig(
          buildGoogleThinkingLevelConfig(options.thinking.level),
          { includeThoughts: true },
        );
      } else if (options.thinking?.budgetTokens !== undefined) {
        config.thinkingConfig = {
          thinkingBudget: options.thinking.budgetTokens,
          includeThoughts: true,
        };
      } else if (isGemini3Model(model.id)) {
        config.thinkingConfig = toSDKThinkingConfig(buildGoogleThinkingLevelConfig("MEDIUM"), {
          includeThoughts: true,
        });
      }
    } else {
      config.thinkingConfig = toSDKThinkingConfig(getDisabledThinkingConfig(model.id));
    }
  }

  return {
    model: model.id,
    contents: convertMessages(model, context, options),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}
