import type { Context, Model } from "../../contracts/index.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import {
  buildGoogleThinkingLevelConfig,
  getDisabledThinkingConfig,
  isGemini3Model,
} from "./compat.js";
import type { CloudCodeAssistRequest, GoogleGeminiCliOptions } from "./contract.js";
import { convertMessages, convertTools, mapToolChoice } from "./shared.js";

export function buildRequest(
  model: Model<"google-gemini-cli">,
  context: Context,
  projectId: string,
  options: GoogleGeminiCliOptions = {},
): CloudCodeAssistRequest {
  const contents = convertMessages(model, context, options);
  const userAgent = "google-cloud-sdk vscode_cloudshelleditor/0.1";
  const request: CloudCodeAssistRequest = {
    project: projectId,
    model: model.id,
    request: {
      contents,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.cacheControl?.cachedContent
        ? { cachedContent: options.cacheControl.cachedContent.name }
        : {}),
      generationConfig: {
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
      },
    },
    requestType: "LIVE",
    userAgent,
    requestId: options.requestId,
  };

  if (context.systemPrompt) {
    request.request.systemInstruction = {
      parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
    };
  }

  if (context.tools && context.tools.length > 0) {
    const useParameters = model.id.toLowerCase().startsWith("claude-");
    request.request.tools = convertTools(context.tools, useParameters);
  }

  if (options.toolChoice) {
    request.request.toolConfig = {
      functionCallingConfig: {
        mode: mapToolChoice(options.toolChoice),
      },
    };
  }

  if (model.reasoning) {
    const thinkingEnabled = options.thinking?.enabled === true;
    if (thinkingEnabled) {
      if (options.thinking?.level) {
        request.request.generationConfig!.thinkingConfig = buildGoogleThinkingLevelConfig(
          options.thinking.level,
        );
      } else if (options.thinking?.budgetTokens) {
        request.request.generationConfig!.thinkingConfig = {
          thinkingBudget: options.thinking.budgetTokens,
        };
      } else if (isGemini3Model(model.id)) {
        request.request.generationConfig!.thinkingConfig = buildGoogleThinkingLevelConfig("MEDIUM");
      }
    } else {
      request.request.generationConfig!.thinkingConfig = getDisabledThinkingConfig(model.id);
    }
  }

  return request;
}
