import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { resolveAnthropicCacheRender } from "../../cache/render/anthropic.js";
import type { Context, Model } from "../../contracts/index.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "../_shared/github-copilot-headers.js";
import { claudeCodeVersion, isOAuthToken, supportsAdaptiveThinking } from "./compat.js";
import type { AnthropicOptions } from "./contract.js";
import {
  convertMessages,
  createAnthropicCacheControlAllocator,
  applySystemCacheBreakpoint,
} from "./messages.js";
import { convertTools } from "./tools.js";

function mergeHeaders(
  ...headerSources: (Record<string, string> | undefined)[]
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const headers of headerSources) {
    if (headers) {
      Object.assign(merged, headers);
    }
  }
  return merged;
}

export function createAnthropicClient(
  model: Model<"anthropic-messages">,
  apiKey: string,
  interleavedThinking: boolean,
  optionsHeaders?: Record<string, string>,
  dynamicHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean; headers: Record<string, string> } {
  const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(model.id);

  if (model.provider === "github-copilot") {
    const betaFeatures: string[] = [];
    if (needsInterleavedBeta) {
      betaFeatures.push("interleaved-thinking-2025-05-14");
    }

    const headers = mergeHeaders(
      {
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
      },
      model.headers,
      dynamicHeaders,
      optionsHeaders,
    );
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: headers,
    });

    return { client, isOAuthToken: false, headers };
  }

  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
  if (needsInterleavedBeta) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }

  if (isOAuthToken(apiKey)) {
    const headers = mergeHeaders(
      {
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
        "user-agent": `claude-cli/${claudeCodeVersion}`,
        "x-app": "cli",
      },
      model.headers,
      optionsHeaders,
    );
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: headers,
    });

    return { client, isOAuthToken: true, headers };
  }

  const headers = mergeHeaders(
    {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": betaFeatures.join(","),
    },
    model.headers,
    optionsHeaders,
  );
  const client = new Anthropic({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
  });

  return { client, isOAuthToken: false, headers };
}

export function buildAnthropicParams(
  model: Model<"anthropic-messages">,
  context: Context,
  oauthToken: boolean,
  options?: AnthropicOptions,
): MessageCreateParamsStreaming {
  const cacheRender = resolveAnthropicCacheRender({
    baseUrl: model.baseUrl,
    provider: model.provider,
    modelId: model.id,
    sessionId: options?.sessionId,
    policy: options?.cachePolicy,
  });
  void options?.onCacheRender?.(cacheRender, model);
  const cacheControl = cacheRender.cacheControl;
  const cacheControlAllocator = createAnthropicCacheControlAllocator(cacheControl);
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages: [],
    max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
    stream: true,
  };

  if (oauthToken) {
    params.system = [
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ];
    if (context.systemPrompt) {
      params.system.push({
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
      });
    }
  } else if (context.systemPrompt) {
    params.system = [
      {
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
      },
    ];
  }
  if (params.system) {
    applySystemCacheBreakpoint(params.system, cacheControlAllocator);
  }

  if (options?.temperature !== undefined && !options?.thinkingEnabled) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    params.tools = convertTools(context.tools, oauthToken, cacheControlAllocator);
  }

  params.messages = convertMessages(
    context.messages,
    model,
    oauthToken,
    cacheControlAllocator,
    options,
  );

  if (model.reasoning) {
    if (options?.thinkingEnabled) {
      if (supportsAdaptiveThinking(model.id)) {
        params.thinking = { type: "adaptive" };
        if (options.effort) {
          params.output_config = { effort: options.effort };
        }
      } else {
        params.thinking = {
          type: "enabled",
          budget_tokens: options.thinkingBudgetTokens || 1024,
        };
      }
    } else if (options?.thinkingEnabled === false) {
      params.thinking = { type: "disabled" };
    }
  }

  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }

  if (options?.toolChoice) {
    if (typeof options.toolChoice === "string") {
      params.tool_choice = { type: options.toolChoice };
    } else {
      params.tool_choice = options.toolChoice;
    }
  }

  return params;
}

export function resolveCopilotDynamicHeaders(
  model: Model<"anthropic-messages">,
  context: Context,
): Record<string, string> | undefined {
  if (model.provider !== "github-copilot") {
    return undefined;
  }
  const hasImages = hasCopilotVisionInput(context.messages);
  return buildCopilotDynamicHeaders({
    messages: context.messages,
    hasImages,
  });
}
