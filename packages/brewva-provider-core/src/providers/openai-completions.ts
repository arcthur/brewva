import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { resolveOpenAICompletionsCacheRender } from "../cache-policy.js";
import { calculateCost, supportsXhigh } from "../models.js";
import { runProviderStream } from "../streaming/stream-runner.js";
import type { IncrementalToolCallFolder } from "../streaming/tool-call-folder.js";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { buildProviderPayloadMetadata } from "./payload-metadata.js";
import { materializeUserMessageContent } from "./prompt-content.js";
import { buildBaseOptions, clampReasoning } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      return true;
    }
    if (msg.role === "assistant") {
      if (msg.content.some((block) => block.type === "toolCall")) {
        return true;
      }
    }
  }
  return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export const streamOpenAICompletions: StreamFunction<
  "openai-completions",
  OpenAICompletionsOptions
> = (
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
  return runProviderStream(
    model,
    async ({ stream, output, ensureStarted, composer }) => {
      const apiKey = options?.apiKey || "";
      const client = createClient(model, context, apiKey, options?.headers);
      const cacheRender = resolveOpenAICompletionsCacheRender({
        provider: model.provider,
        modelId: model.id,
        baseUrl: model.baseUrl,
        sessionId: options?.sessionId,
        policy: options?.cachePolicy,
        transport: options?.transport,
      });
      void options?.onCacheRender?.(cacheRender, model);
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(
        params,
        model,
        buildProviderPayloadMetadata(model, options, params, cacheRender),
      );
      if (nextParams !== undefined) {
        params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
      }
      const openaiStream = await client.chat.completions.create(params, {
        signal: options?.signal,
      });
      ensureStarted();
      try {
        await processOpenAICompletionsStream(
          openaiStream,
          output,
          stream,
          model,
          composer.toolCalls,
        );
      } catch (error) {
        const rawMetadata = (error as any)?.error?.metadata?.raw;
        if (rawMetadata) {
          throw new Error(
            `${error instanceof Error ? error.message : JSON.stringify(error)}\n${rawMetadata}`,
          );
        }
        throw error;
      }
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }
    },
    {
      signal: options?.signal,
      startMode: "lazy",
      tools: context.tools,
    },
  );
};

export const streamSimpleOpenAICompletions: StreamFunction<
  "openai-completions",
  SimpleStreamOptions
> = (
  model: Model<"openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);
  const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;

  return streamOpenAICompletions(model, context, {
    ...base,
    reasoningEffort,
    toolChoice,
  } satisfies OpenAICompletionsOptions);
};

type OpenAICompletionCurrentBlock =
  | {
      type: "text";
      block: TextContent;
      outputIndex: number;
    }
  | {
      type: "thinking";
      block: ThinkingContent;
      outputIndex: number;
    }
  | null;

async function processOpenAICompletionsStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-completions">,
  toolCalls: IncrementalToolCallFolder,
): Promise<void> {
  let currentBlock: OpenAICompletionCurrentBlock = null;

  const finishCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: currentBlock.outputIndex,
        content: currentBlock.block.text,
        partial: output,
      });
      currentBlock = null;
      return;
    }
    if (currentBlock.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: currentBlock.outputIndex,
        content: currentBlock.block.thinking,
        partial: output,
      });
      currentBlock = null;
      return;
    }
    currentBlock = null;
  };

  const getReasoningField = (delta: Record<string, any>): string | null => {
    for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
      if (delta[field] !== null && delta[field] !== undefined && delta[field].length > 0) {
        return field;
      }
    }
    return null;
  };

  const resolveToolCallKey = (toolCall: {
    index?: number;
    id?: string;
    function?: { name?: string };
  }): string => {
    if (typeof toolCall.index === "number" && Number.isFinite(toolCall.index)) {
      return `index:${toolCall.index}`;
    }
    if (toolCall.id) {
      return `id:${toolCall.id}`;
    }
    if (toolCall.function?.name) {
      for (const block of output.content) {
        if (block.type === "toolCall" && block.name === toolCall.function.name) {
          return `name:${toolCall.function.name}`;
        }
      }
    }
    const toolCallCount = output.content.filter((block) => block.type === "toolCall").length;
    if (toolCallCount === 1) {
      const onlyToolCall = output.content.find((block) => block.type === "toolCall");
      if (onlyToolCall) {
        return `id:${onlyToolCall.id}`;
      }
    }
    return `slot:${toolCallCount}`;
  };

  for await (const chunk of openaiStream) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }

    output.responseId ||= chunk.id;
    if (chunk.usage) {
      output.usage = normalizeOpenAICompletionsUsage(chunk.usage, model);
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      continue;
    }

    if (!chunk.usage && (choice as any).usage) {
      output.usage = normalizeOpenAICompletionsUsage((choice as any).usage, model);
    }

    if (choice.finish_reason) {
      const finishReasonResult = mapStopReason(choice.finish_reason);
      output.stopReason = finishReasonResult.stopReason;
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }

    if (!choice.delta) {
      continue;
    }

    if (
      choice.delta.content !== null &&
      choice.delta.content !== undefined &&
      choice.delta.content.length > 0
    ) {
      if (!currentBlock || currentBlock.type !== "text") {
        finishCurrentBlock();
        const block: TextContent = { type: "text", text: "" };
        output.content.push(block);
        currentBlock = {
          type: "text",
          block,
          outputIndex: output.content.length - 1,
        };
        stream.push({
          type: "text_start",
          contentIndex: currentBlock.outputIndex,
          partial: output,
        });
      }
      if (currentBlock.type === "text") {
        currentBlock.block.text += choice.delta.content;
        stream.push({
          type: "text_delta",
          contentIndex: currentBlock.outputIndex,
          delta: choice.delta.content,
          partial: output,
        });
      }
    }

    const reasoningField = getReasoningField(choice.delta as Record<string, any>);
    if (reasoningField) {
      if (!currentBlock || currentBlock.type !== "thinking") {
        finishCurrentBlock();
        const block: ThinkingContent = {
          type: "thinking",
          thinking: "",
          thinkingSignature: reasoningField,
        };
        output.content.push(block);
        currentBlock = {
          type: "thinking",
          block,
          outputIndex: output.content.length - 1,
        };
        stream.push({
          type: "thinking_start",
          contentIndex: currentBlock.outputIndex,
          partial: output,
        });
      }
      if (currentBlock.type === "thinking") {
        const delta = (choice.delta as any)[reasoningField];
        currentBlock.block.thinking += delta;
        stream.push({
          type: "thinking_delta",
          contentIndex: currentBlock.outputIndex,
          delta,
          partial: output,
        });
      }
    }

    if (choice.delta.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
        if (currentBlock) {
          finishCurrentBlock();
        }
        const toolCallKey = resolveToolCallKey(toolCall);
        toolCalls.begin(toolCallKey, {
          id: toolCall.id || "",
          name: toolCall.function?.name || "",
          arguments: {},
        });
        toolCalls.appendArgumentsDelta(toolCallKey, toolCall.function?.arguments || "", {
          ...(toolCall.id ? { id: toolCall.id } : {}),
          ...(toolCall.function?.name ? { name: toolCall.function.name } : {}),
        });
      }
    }

    const reasoningDetails = (choice.delta as any).reasoning_details;
    if (reasoningDetails && Array.isArray(reasoningDetails)) {
      for (const detail of reasoningDetails) {
        if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
          const matchingToolCall = output.content.find(
            (block) => block.type === "toolCall" && block.id === detail.id,
          ) as ToolCall | undefined;
          if (matchingToolCall) {
            matchingToolCall.thoughtSignature = JSON.stringify(detail);
          }
        }
      }
    }
  }

  finishCurrentBlock();
  toolCalls.finalizeAll();
}

function createClient(
  model: Model<"openai-completions">,
  context: Context,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages,
    });
    Object.assign(headers, copilotHeaders);
  }

  // Merge options headers last so they can override defaults
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
  });
}

export function buildOpenAICompletionsParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
) {
  const compat = getCompat(model);
  const messages = convertMessages(model, context, compat, options);
  maybeAddOpenRouterAnthropicCacheControl(model, messages);

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages,
    stream: true,
  };

  if (compat.supportsUsageInStreaming !== false) {
    (params as any).stream_options = { include_usage: true };
  }

  if (compat.supportsStore) {
    params.store = false;
  }

  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      (params as any).max_tokens = options.maxTokens;
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
  } else if (hasToolHistory(context.messages)) {
    // Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
    params.tools = [];
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }

  if (compat.thinkingFormat === "qwen" && model.reasoning) {
    (params as any).enable_thinking = !!options?.reasoningEffort;
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    (params as any).chat_template_kwargs = { enable_thinking: !!options?.reasoningEffort };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    (params as any).thinking = {
      type: options?.reasoningEffort ? "enabled" : "disabled",
    };
    if (options?.reasoningEffort && compat.supportsReasoningEffort) {
      (params as any).reasoning_effort = mapReasoningEffort(
        options.reasoningEffort,
        compat.reasoningEffortMap,
      );
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    // OpenRouter normalizes reasoning across providers via a nested reasoning object.
    const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
    if (options?.reasoningEffort) {
      openRouterParams.reasoning = {
        effort: mapReasoningEffort(options.reasoningEffort, compat.reasoningEffortMap),
      };
    } else {
      openRouterParams.reasoning = { effort: "none" };
    }
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    // OpenAI-style reasoning_effort
    (params as any).reasoning_effort = mapReasoningEffort(
      options.reasoningEffort,
      compat.reasoningEffortMap,
    );
  }

  // OpenRouter provider routing preferences
  if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
    (params as any).provider = model.compat.openRouterRouting;
  }

  return params;
}

const buildParams = buildOpenAICompletionsParams;

function mapReasoningEffort(
  effort: NonNullable<OpenAICompletionsOptions["reasoningEffort"]>,
  reasoningEffortMap: Partial<
    Record<NonNullable<OpenAICompletionsOptions["reasoningEffort"]>, string>
  >,
): string {
  return reasoningEffortMap[effort] ?? effort;
}

function maybeAddOpenRouterAnthropicCacheControl(
  model: Model<"openai-completions">,
  messages: ChatCompletionMessageParam[],
): void {
  if (model.provider !== "openrouter" || !model.id.startsWith("anthropic/")) return;

  // Anthropic-style caching requires cache_control on a text part. Add a breakpoint
  // on the last user/assistant message (walking backwards until we find text content).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const content = msg.content;
    if (typeof content === "string") {
      msg.content = [
        Object.assign(
          { type: "text" as const, text: content },
          { cache_control: { type: "ephemeral" } },
        ),
      ];
      return;
    }

    if (!Array.isArray(content)) continue;

    // Find last text part and add cache_control
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part?.type === "text") {
        Object.assign(part, { cache_control: { type: "ephemeral" } });
        return;
      }
    }
  }
}

export function convertMessages(
  model: Model<"openai-completions">,
  context: Context,
  compat: Required<OpenAICompletionsCompat>,
  options?: Pick<StreamOptions, "resolveFile">,
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  const normalizeToolCallId = (id: string): string => {
    // Handle pipe-separated IDs from OpenAI Responses API
    // Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
    // These come from providers like github-copilot and openai-codex.
    // Extract just the call_id part and normalize it
    if (id.includes("|")) {
      const [callId] = id.split("|");
      // Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
      return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    }

    if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
    return id;
  };

  const transformedMessages = transformMessages(context.messages, model, (id) =>
    normalizeToolCallId(id),
  );

  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    const role = useDeveloperRole ? "developer" : "system";
    params.push({ role: role, content: sanitizeSurrogates(context.systemPrompt) });
  }

  let lastRole: string | null = null;

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    // Some providers don't allow user messages directly after tool results
    // Insert a synthetic assistant message to bridge the gap
    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      msg.role === "user"
    ) {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }

    if (msg.role === "user") {
      const materializedContent = materializeUserMessageContent(model, msg.content, options);
      const content: ChatCompletionContentPart[] = materializedContent.map(
        (item): ChatCompletionContentPart => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text),
            } satisfies ChatCompletionContentPartText;
          }
          return {
            type: "image_url",
            image_url: {
              url: `data:${item.mimeType};base64,${item.data}`,
            },
          } satisfies ChatCompletionContentPartImage;
        },
      );
      const filteredContent = !model.input.includes("image")
        ? content.filter((c) => c.type !== "image_url")
        : content;
      if (filteredContent.length === 0) continue;
      params.push({
        role: "user",
        content: filteredContent,
      });
    } else if (msg.role === "assistant") {
      // Some providers don't accept null content, use empty string instead
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const textBlocks = msg.content.filter((b) => b.type === "text") as TextContent[];
      // Filter out empty text blocks to avoid API validation errors
      const nonEmptyTextBlocks = textBlocks.filter((b) => b.text && b.text.trim().length > 0);
      if (nonEmptyTextBlocks.length > 0) {
        // Always send assistant content as a plain string (OpenAI Chat Completions
        // API standard format). Sending as an array of {type:"text", text:"..."}
        // objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
        // NVIDIA NIM) to mirror the content-block structure literally in their
        // output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
        assistantMsg.content = nonEmptyTextBlocks.map((b) => sanitizeSurrogates(b.text)).join("");
      }

      const toolCalls = msg.content.filter((b) => b.type === "toolCall") as ToolCall[];

      // Handle thinking blocks
      const thinkingBlocks = msg.content.filter((b) => b.type === "thinking") as ThinkingContent[];
      // Filter out empty thinking blocks to avoid API validation errors
      const nonEmptyThinkingBlocks = thinkingBlocks.filter(
        (b) => b.thinking && b.thinking.trim().length > 0,
      );
      const shouldSerializeThinking =
        nonEmptyThinkingBlocks.length > 0 &&
        (compat.thinkingFormat !== "deepseek" || toolCalls.length > 0);
      if (shouldSerializeThinking) {
        if (compat.requiresThinkingAsText) {
          // Convert thinking blocks to plain text (no tags to avoid model mimicking them)
          const thinkingText = nonEmptyThinkingBlocks.map((b) => b.thinking).join("\n\n");
          const textContent = assistantMsg.content as Array<{ type: "text"; text: string }> | null;
          if (textContent) {
            textContent.unshift({ type: "text", text: thinkingText });
          } else {
            assistantMsg.content = [{ type: "text", text: thinkingText }];
          }
        } else {
          // Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
          const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
          if (signature && signature.length > 0) {
            (assistantMsg as any)[signature] = nonEmptyThinkingBlocks
              .map((b) => b.thinking)
              .join("\n");
          }
        }
      }

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
        const reasoningDetails = toolCalls
          .filter((tc) => tc.thoughtSignature)
          .map((tc) => {
            try {
              return JSON.parse(tc.thoughtSignature!);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (reasoningDetails.length > 0) {
          (assistantMsg as any).reasoning_details = reasoningDetails;
        }
      }
      // Skip assistant messages that have no content and no tool calls.
      // Some providers require "either content or tool_calls, but not none".
      // Other providers also don't accept empty assistant messages.
      // This handles aborted assistant responses that got no content.
      const content = assistantMsg.content;
      const hasContent =
        content !== null &&
        content !== undefined &&
        (typeof content === "string" ? content.length > 0 : content.length > 0);
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      let j = i;

      for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
        const toolMsg = transformedMessages[j] as ToolResultMessage;

        // Extract text and image content
        const textResult = toolMsg.content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).text)
          .join("\n");
        const hasImages = toolMsg.content.some((c) => c.type === "image");

        // Always send tool result with text (or placeholder if only images)
        const hasText = textResult.length > 0;
        // Some providers require the 'name' field in tool results
        const toolResultMsg: ChatCompletionToolMessageParam = {
          role: "tool",
          content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
          tool_call_id: toolMsg.toolCallId,
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          (toolResultMsg as any).name = toolMsg.toolName;
        }
        params.push(toolResultMsg);

        if (hasImages && model.input.includes("image")) {
          for (const block of toolMsg.content) {
            if (block.type === "image") {
              imageBlocks.push({
                type: "image_url",
                image_url: {
                  url: `data:${(block as any).mimeType};base64,${(block as any).data}`,
                },
              });
            }
          }
        }
      }

      i = j - 1;

      if (imageBlocks.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({
            role: "assistant",
            content: "I have processed the tool results.",
          });
        }

        params.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Attached image(s) from tool result:",
            },
            ...imageBlocks,
          ],
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }
      continue;
    }

    lastRole = msg.role;
  }

  return params;
}

function convertTools(
  tools: Tool[],
  compat: Required<OpenAICompletionsCompat>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as any, // TypeBox already generates JSON Schema
      // Only include strict if provider supports it. Some reject unknown fields.
      ...(compat.supportsStrictMode !== false && { strict: false }),
    },
  }));
}

function readUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeOpenAICompletionsUsage(
  rawUsage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  },
  model: Model<"openai-completions">,
): AssistantMessage["usage"] {
  const promptTokens = readUsageNumber(rawUsage.prompt_tokens) ?? 0;
  const deepSeekCacheHitTokens = readUsageNumber(rawUsage.prompt_cache_hit_tokens);
  const deepSeekCacheMissTokens = readUsageNumber(rawUsage.prompt_cache_miss_tokens);
  const isDeepSeek = isDeepSeekRoute(model);
  const isDeepSeekUsage =
    isDeepSeek && (deepSeekCacheHitTokens !== undefined || deepSeekCacheMissTokens !== undefined);
  if (isDeepSeekUsage) {
    const cacheReadTokens = deepSeekCacheHitTokens ?? 0;
    const input = deepSeekCacheMissTokens ?? Math.max(0, promptTokens - cacheReadTokens);
    const outputTokens = readUsageNumber(rawUsage.completion_tokens) ?? 0;
    const usage: AssistantMessage["usage"] = {
      input,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: 0,
      totalTokens: input + outputTokens + cacheReadTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);
    return usage;
  }

  const reportedCachedTokens =
    readUsageNumber(rawUsage.prompt_tokens_details?.cached_tokens) ??
    readUsageNumber(rawUsage.cached_tokens) ??
    0;
  const cacheWriteTokens = isDeepSeek
    ? 0
    : (readUsageNumber(rawUsage.prompt_tokens_details?.cache_write_tokens) ?? 0);
  const reasoningTokens = isDeepSeek
    ? 0
    : (readUsageNumber(rawUsage.completion_tokens_details?.reasoning_tokens) ?? 0);

  // Normalize to Brewva semantics:
  // - cacheRead: hits from cache created by previous requests only
  // - cacheWrite: tokens written to cache in this request
  // Some OpenAI-compatible providers (observed on OpenRouter) report cached_tokens
  // as (previous hits + current writes). In that case, remove cacheWrite from cacheRead.
  const cacheReadTokens =
    cacheWriteTokens > 0
      ? Math.max(0, reportedCachedTokens - cacheWriteTokens)
      : reportedCachedTokens;

  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  // Compute totalTokens ourselves since we add reasoning_tokens to output
  // and some Groq-compatible endpoints do not include them in total_tokens.
  const outputTokens = (readUsageNumber(rawUsage.completion_tokens) ?? 0) + reasoningTokens;
  const usage: AssistantMessage["usage"] = {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
  stopReason: StopReason;
  errorMessage?: string;
} {
  if (reason === null) return { stopReason: "stop" };
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 * Returns a fully resolved OpenAICompletionsCompat object with all fields set.
 */
function isDeepSeekRoute(model: Model<"openai-completions">): boolean {
  if (model.provider === "deepseek") {
    return true;
  }
  try {
    const url = new URL(model.baseUrl);
    return url.hostname === "api.deepseek.com" || url.hostname.endsWith(".deepseek.com");
  } catch {
    return model.baseUrl.includes("deepseek.com");
  }
}

function detectCompat(model: Model<"openai-completions">): Required<OpenAICompletionsCompat> {
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  const isDeepSeek = isDeepSeekRoute(model);

  const isNonStandard = baseUrl.includes("api.x.ai") || baseUrl.includes("chutes.ai") || isDeepSeek;

  const useMaxTokens = baseUrl.includes("chutes.ai") || isDeepSeek;

  const hasXaiReasoningLimits = baseUrl.includes("api.x.ai");
  const hasGroqEndpointQuirk = baseUrl.includes("groq.com");

  const reasoningEffortMap = isDeepSeek
    ? {
        minimal: "high",
        low: "high",
        medium: "high",
        high: "high",
        xhigh: "max",
      }
    : hasGroqEndpointQuirk && model.id === "qwen/qwen3-32b"
      ? {
          minimal: "default",
          low: "default",
          medium: "default",
          high: "default",
          xhigh: "default",
        }
      : {};
  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: !hasXaiReasoningLimits,
    reasoningEffortMap,
    supportsUsageInStreaming: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: isDeepSeek
      ? "deepseek"
      : provider === "openrouter" || baseUrl.includes("openrouter.ai")
        ? "openrouter"
        : "openai",
    openRouterRouting: {},
    supportsStrictMode: !isDeepSeek,
  };
}

/**
 * Get resolved compatibility settings for a model.
 * Uses explicit model.compat if provided, otherwise auto-detects from provider/URL.
 */
export function resolveOpenAICompletionsCompat(
  model: Model<"openai-completions">,
): Required<OpenAICompletionsCompat> {
  const detected = detectCompat(model);
  if (!model.compat) return detected;

  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort:
      model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    reasoningEffortMap: model.compat.reasoningEffortMap ?? detected.reasoningEffortMap,
    supportsUsageInStreaming:
      model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: model.compat.openRouterRouting ?? {},
    supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
  };
}

const getCompat = resolveOpenAICompletionsCompat;

export const OPENAI_COMPLETIONS_TEST_ONLY = {
  processOpenAICompletionsStream,
  buildOpenAICompletionsParams,
  resolveOpenAICompletionsCompat,
} as const;
