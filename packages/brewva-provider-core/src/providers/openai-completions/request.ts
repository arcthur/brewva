import type OpenAI from "openai";
import type {
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import {
  resolveOpenAICompletionsCacheRender,
  type OpenAICompletionsCacheControl,
  type OpenAICompletionsCacheRender,
} from "../../cache/render/openai-completions.js";
import type {
  Context,
  Model,
  ResolvedOpenAICompletionsCompat,
  StreamOptions,
} from "../../contracts/index.js";
import { resolveOpenAICompletionsCompat } from "./compat.js";
import type { OpenAICompletionsOptions } from "./contract.js";
import { convertMessages } from "./messages.js";
import { convertTools, hasToolHistory } from "./tools.js";
import { readOpenRouterRouting, withOpenAICompletionsCompat } from "./wire.js";

function mapReasoningEffort(
  effort: NonNullable<OpenAICompletionsOptions["reasoningEffort"]>,
  reasoningEffortMap: Partial<
    Record<NonNullable<OpenAICompletionsOptions["reasoningEffort"]>, string>
  >,
): string {
  return reasoningEffortMap[effort] ?? effort;
}

function resolveRequestCacheRender(
  model: Model<"openai-completions">,
  options: OpenAICompletionsOptions | undefined,
  compat: ResolvedOpenAICompletionsCompat,
  cacheRender: OpenAICompletionsCacheRender | undefined,
): OpenAICompletionsCacheRender {
  if (cacheRender) {
    return cacheRender;
  }
  return resolveOpenAICompletionsCacheRender({
    provider: model.provider,
    modelId: model.id,
    baseUrl: model.baseUrl,
    sessionId: options?.sessionId,
    policy: options?.cachePolicy,
    transport: options?.transport,
    cacheControlFormat: compat.cacheControlFormat,
    supportsPromptCacheKey: compat.supportsPromptCacheKey,
    supportsLongCacheRetention: compat.supportsLongCacheRetention,
  });
}

function applyOpenAICompletionsCacheControl(
  messages: ChatCompletionMessageParam[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  cacheControl: OpenAICompletionsCacheControl,
): void {
  applyInstructionCacheControl(messages, cacheControl);
  applyLastToolCacheControl(tools, cacheControl);
  applyLastConversationTextCacheControl(messages, cacheControl);
}

function applyInstructionCacheControl(
  messages: ChatCompletionMessageParam[],
  cacheControl: OpenAICompletionsCacheControl,
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || (message.role !== "system" && message.role !== "developer")) {
      continue;
    }
    if (applyCacheControlToMessageText(message, "last", cacheControl)) {
      return;
    }
  }
}

function applyLastToolCacheControl(
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  cacheControl: OpenAICompletionsCacheControl,
): void {
  const lastTool = tools?.at(-1);
  if (!lastTool) {
    return;
  }
  const compatTool = lastTool as typeof lastTool & {
    cache_control?: OpenAICompletionsCacheControl;
  };
  compatTool.cache_control ??= cacheControl;
}

function applyLastConversationTextCacheControl(
  messages: ChatCompletionMessageParam[],
  cacheControl: OpenAICompletionsCacheControl,
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    if (applyCacheControlToMessageText(message, "last", cacheControl)) {
      return;
    }
  }
}

function applyCacheControlToMessageText(
  message: ChatCompletionMessageParam,
  position: "first" | "last",
  cacheControl: OpenAICompletionsCacheControl,
): boolean {
  const mutableMessage = message as ChatCompletionMessageParam & { content?: unknown };
  const content = mutableMessage.content;
  if (typeof content === "string") {
    const textPart: ChatCompletionContentPartText & {
      cache_control: OpenAICompletionsCacheControl;
    } = {
      type: "text",
      text: content,
      cache_control: cacheControl,
    };
    mutableMessage.content = [textPart];
    return true;
  }

  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }

  const indexes =
    position === "first"
      ? content.map((_, index) => index)
      : content.map((_, index) => index).reverse();
  for (const index of indexes) {
    const part = content[index] as
      | ({ type?: unknown; text?: unknown; cache_control?: OpenAICompletionsCacheControl } & Record<
          string,
          unknown
        >)
      | undefined;
    if (!part || part.type !== "text" || typeof part.text !== "string") {
      continue;
    }
    if (part.cache_control) {
      return true;
    }
    part.cache_control = cacheControl;
    return true;
  }
  return false;
}

export function buildOpenAICompletionsParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
  cacheRender?: OpenAICompletionsCacheRender,
) {
  const compat = resolveOpenAICompletionsCompat(model);
  const resolvedCacheRender = resolveRequestCacheRender(model, options, compat, cacheRender);
  const messages = convertMessages(
    model,
    context,
    compat,
    options as Pick<StreamOptions, "resolveFile">,
  );

  const params = withOpenAICompletionsCompat({
    model: model.id,
    messages,
    stream: true,
  });
  if (resolvedCacheRender.promptCacheKey) {
    params.prompt_cache_key = resolvedCacheRender.promptCacheKey;
  }
  if (resolvedCacheRender.promptCacheRetention) {
    params.prompt_cache_retention = resolvedCacheRender.promptCacheRetention;
  }

  if (compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }

  if (compat.supportsStore) {
    params.store = false;
  }

  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }

  const deepSeekThinkingEnabled =
    compat.thinkingFormat === "deepseek" && model.reasoning && !!options?.reasoningEffort;
  if (options?.temperature !== undefined && !deepSeekThinkingEnabled) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    params.tools = convertTools(context.tools, compat);
    if (resolvedCacheRender.cacheControl) {
      applyLastToolCacheControl(params.tools, resolvedCacheRender.cacheControl);
    }
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }

  if (resolvedCacheRender.cacheControl) {
    applyOpenAICompletionsCacheControl(messages, params.tools, resolvedCacheRender.cacheControl);
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }

  if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    params.chat_template_kwargs = { enable_thinking: !!options?.reasoningEffort };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = {
      type: options?.reasoningEffort ? "enabled" : "disabled",
    };
    if (options?.reasoningEffort && compat.supportsReasoningEffort) {
      params.reasoning_effort = mapReasoningEffort(
        options.reasoningEffort,
        compat.reasoningEffortMap,
      );
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
    if (options?.reasoningEffort) {
      openRouterParams.reasoning = {
        effort: mapReasoningEffort(options.reasoningEffort, compat.reasoningEffortMap),
      };
    } else {
      openRouterParams.reasoning = { effort: "none" };
    }
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    params.reasoning_effort = mapReasoningEffort(
      options.reasoningEffort,
      compat.reasoningEffortMap,
    );
  }

  if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
    params.provider = readOpenRouterRouting(model.compat.openRouterRouting);
  }

  return params;
}
