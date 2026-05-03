import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { resolveAnthropicCacheRender } from "../cache-policy.js";
import { calculateCost } from "../models.js";
import { runProviderStream } from "../streaming/stream-runner.js";
import type { IncrementalToolCallFolder } from "../streaming/tool-call-folder.js";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
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
import {
  buildAnthropicDocumentBlock,
  materializeResolvedUserMessageContentPart,
  resolveUserMessageContent,
} from "./prompt-content.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
  if (tools && tools.length > 0) {
    const lowerName = name.toLowerCase();
    const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
    if (matchedTool) return matchedTool.name;
  }
  return name;
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
    > {
  // If only text blocks, return as concatenated string for simplicity
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
  }

  // If we have images, convert to content block array
  const blocks = content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text" as const,
        text: sanitizeSurrogates(block.text),
      };
    }
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: block.data,
      },
    };
  });

  // If only images (no text), add placeholder text block
  const hasText = blocks.some((b) => b.type === "text");
  if (!hasText) {
    blocks.unshift({
      type: "text" as const,
      text: "(see attached image)",
    });
  }

  return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "max";

export interface AnthropicOptions extends StreamOptions {
  /**
   * Enable extended thinking.
   * For Opus 4.6 and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
   * For older models: uses budget-based thinking with thinkingBudgetTokens.
   */
  thinkingEnabled?: boolean;
  /**
   * Token budget for extended thinking (older models only).
   * Ignored for Opus 4.6 and Sonnet 4.6, which use adaptive thinking.
   */
  thinkingBudgetTokens?: number;
  /**
   * Effort level for adaptive thinking (Opus 4.6 and Sonnet 4.6).
   * Controls how much thinking Claude allocates:
   * - "max": Always thinks with no constraints (Opus 4.6 only)
   * - "high": Always thinks, deep reasoning (default)
   * - "medium": Moderate thinking, may skip for simple queries
   * - "low": Minimal thinking, skips for simple tasks
   * Ignored for older models.
   */
  effort?: AnthropicEffort;
  interleavedThinking?: boolean;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  /**
   * Pre-built Anthropic client instance. When provided, skips internal client
   * construction entirely. Use this to inject alternative SDK clients such as
   * `AnthropicVertex` that shares the same messaging API.
   */
  client?: Anthropic;
}

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

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
): AssistantMessageEventStream => {
  return runProviderStream(
    model,
    async ({ stream, output, ensureStarted, composer }) => {
      let client: Anthropic;
      let isOAuth: boolean;
      let requestHeaders: Record<string, string> | undefined;

      if (options?.client) {
        client = options.client;
        isOAuth = false;
        requestHeaders = options.headers;
      } else {
        const apiKey = options?.apiKey ?? "";

        let copilotDynamicHeaders: Record<string, string> | undefined;
        if (model.provider === "github-copilot") {
          const hasImages = hasCopilotVisionInput(context.messages);
          copilotDynamicHeaders = buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages,
          });
        }

        const created = createClient(
          model,
          apiKey,
          options?.interleavedThinking ?? true,
          options?.headers,
          copilotDynamicHeaders,
        );
        client = created.client;
        isOAuth = created.isOAuthToken;
        requestHeaders = created.headers;
      }
      let params = buildParams(model, context, isOAuth, options);
      const nextParams = await options?.onPayload?.(
        params,
        model,
        buildProviderPayloadMetadata(model, options, params, undefined, {
          headers: requestHeaders,
        }),
      );
      if (nextParams !== undefined) {
        params = nextParams as MessageCreateParamsStreaming;
      }
      const anthropicStream = client.messages.stream(
        { ...params, stream: true },
        { signal: options?.signal },
      );
      ensureStarted();
      await processAnthropicStream(anthropicStream, output, stream, model, composer.toolCalls, {
        isOAuth,
        tools: context.tools,
      });
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }
    },
    {
      signal: options?.signal,
      startMode: "lazy",
    },
  );
};

type AnthropicTextBlockState = {
  type: "text";
  outputIndex: number;
  block: TextContent;
};

type AnthropicThinkingBlockState = {
  type: "thinking";
  outputIndex: number;
  block: ThinkingContent;
};

type AnthropicToolCallBlockState = {
  type: "toolCall";
  outputIndex: number;
  block: ToolCall;
  partialJson: string;
};

type AnthropicBlockState =
  | AnthropicTextBlockState
  | AnthropicThinkingBlockState
  | AnthropicToolCallBlockState;

async function processAnthropicStream(
  anthropicStream: AsyncIterable<any>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"anthropic-messages">,
  toolCalls: IncrementalToolCallFolder,
  options: {
    isOAuth: boolean;
    tools?: Tool[];
  },
): Promise<void> {
  const blocks = new Map<number, AnthropicBlockState>();

  const updateUsageTotals = () => {
    output.usage.totalTokens =
      output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
    calculateCost(model, output.usage);
  };

  for await (const event of anthropicStream) {
    if (event.type === "message_start") {
      output.responseId = event.message.id;
      output.usage.input = event.message.usage.input_tokens || 0;
      output.usage.output = event.message.usage.output_tokens || 0;
      output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
      output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
      updateUsageTotals();
      continue;
    }

    if (event.type === "content_block_start") {
      if (event.content_block.type === "text") {
        const block: TextContent = {
          type: "text",
          text: "",
        };
        output.content.push(block);
        const outputIndex = output.content.length - 1;
        blocks.set(event.index, { type: "text", outputIndex, block });
        stream.push({
          type: "text_start",
          contentIndex: outputIndex,
          partial: output,
        });
        continue;
      }

      if (event.content_block.type === "thinking") {
        const block: ThinkingContent = {
          type: "thinking",
          thinking: "",
          thinkingSignature: "",
        };
        output.content.push(block);
        const outputIndex = output.content.length - 1;
        blocks.set(event.index, { type: "thinking", outputIndex, block });
        stream.push({
          type: "thinking_start",
          contentIndex: outputIndex,
          partial: output,
        });
        continue;
      }

      if (event.content_block.type === "redacted_thinking") {
        const block: ThinkingContent = {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: event.content_block.data,
          redacted: true,
        };
        output.content.push(block);
        const outputIndex = output.content.length - 1;
        blocks.set(event.index, { type: "thinking", outputIndex, block });
        stream.push({
          type: "thinking_start",
          contentIndex: outputIndex,
          partial: output,
        });
        continue;
      }

      if (event.content_block.type === "tool_use") {
        blocks.set(event.index, {
          type: "toolCall",
          outputIndex: toolCalls.begin(
            `anthropic:${event.index}`,
            {
              id: event.content_block.id,
              name: options.isOAuth
                ? fromClaudeCodeName(event.content_block.name, options.tools)
                : event.content_block.name,
              arguments: (event.content_block.input as Record<string, unknown>) ?? {},
            },
            "",
          ),
          block: output.content[output.content.length - 1] as ToolCall,
          partialJson: "",
        });
      }
      continue;
    }

    if (event.type === "content_block_delta") {
      const state = blocks.get(event.index);
      if (!state) {
        continue;
      }

      if (event.delta.type === "text_delta" && state.type === "text") {
        state.block.text += event.delta.text;
        stream.push({
          type: "text_delta",
          contentIndex: state.outputIndex,
          delta: event.delta.text,
          partial: output,
        });
        continue;
      }

      if (event.delta.type === "thinking_delta" && state.type === "thinking") {
        state.block.thinking += event.delta.thinking;
        stream.push({
          type: "thinking_delta",
          contentIndex: state.outputIndex,
          delta: event.delta.thinking,
          partial: output,
        });
        continue;
      }

      if (event.delta.type === "input_json_delta" && state.type === "toolCall") {
        state.partialJson += event.delta.partial_json;
        toolCalls.appendArgumentsDelta(`anthropic:${event.index}`, event.delta.partial_json);
        continue;
      }

      if (event.delta.type === "signature_delta" && state.type === "thinking") {
        state.block.thinkingSignature = state.block.thinkingSignature || "";
        state.block.thinkingSignature += event.delta.signature;
      }
      continue;
    }

    if (event.type === "content_block_stop") {
      const state = blocks.get(event.index);
      if (!state) {
        continue;
      }
      blocks.delete(event.index);
      if (state.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: state.outputIndex,
          content: state.block.text,
          partial: output,
        });
        continue;
      }
      if (state.type === "thinking") {
        stream.push({
          type: "thinking_end",
          contentIndex: state.outputIndex,
          content: state.block.thinking,
          partial: output,
        });
        continue;
      }
      toolCalls.finalize(`anthropic:${event.index}`);
      continue;
    }

    if (event.type === "message_delta") {
      if (event.delta.stop_reason) {
        output.stopReason = mapStopReason(event.delta.stop_reason);
      }
      if (event.usage.input_tokens != null) {
        output.usage.input = event.usage.input_tokens;
      }
      if (event.usage.output_tokens != null) {
        output.usage.output = event.usage.output_tokens;
      }
      if (event.usage.cache_read_input_tokens != null) {
        output.usage.cacheRead = event.usage.cache_read_input_tokens;
      }
      if (event.usage.cache_creation_input_tokens != null) {
        output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
      }
      updateUsageTotals();
    }
  }
}

/**
 * Check if a model supports adaptive thinking (Opus 4.6 and Sonnet 4.6)
 */
function supportsAdaptiveThinking(modelId: string): boolean {
  // Opus 4.6 and Sonnet 4.6 model IDs (with or without date suffix)
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6.
 */
function mapThinkingLevelToEffort(
  level: SimpleStreamOptions["reasoning"],
  modelId: string,
): AnthropicEffort {
  switch (level) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") ? "max" : "high";
    default:
      return "high";
  }
}

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  if (!options?.reasoning) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: false,
    } satisfies AnthropicOptions);
  }

  // For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
  // For older models: use budget-based thinking
  if (supportsAdaptiveThinking(model.id)) {
    const effort = mapThinkingLevelToEffort(options.reasoning, model.id);
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort,
    } satisfies AnthropicOptions);
  }

  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens || 0,
    model.maxTokens,
    options.reasoning,
    options.thinkingBudgets,
  );

  return streamAnthropic(model, context, {
    ...base,
    maxTokens: adjusted.maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: adjusted.thinkingBudget,
  } satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

function createClient(
  model: Model<"anthropic-messages">,
  apiKey: string,
  interleavedThinking: boolean,
  optionsHeaders?: Record<string, string>,
  dynamicHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean; headers: Record<string, string> } {
  // Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
  // The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
  const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(model.id);

  // Copilot: Bearer auth, selective betas (no fine-grained-tool-streaming)
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

  // OAuth: Bearer auth, Claude Code identity headers
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

  // API key auth
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

function buildParams(
  model: Model<"anthropic-messages">,
  context: Context,
  isOAuthToken: boolean,
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

  // For OAuth tokens, we MUST include Claude Code identity
  if (isOAuthToken) {
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
    // Add cache control to system prompt for non-OAuth tokens
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

  // Temperature is incompatible with extended thinking (adaptive or budget-based).
  if (options?.temperature !== undefined && !options?.thinkingEnabled) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    params.tools = convertTools(context.tools, isOAuthToken, cacheControlAllocator);
  }

  params.messages = convertMessages(
    context.messages,
    model,
    isOAuthToken,
    cacheControlAllocator,
    options,
  );

  // Configure thinking mode: adaptive (Opus 4.6 and Sonnet 4.6),
  // budget-based (older models), or explicitly disabled.
  if (model.reasoning) {
    if (options?.thinkingEnabled) {
      if (supportsAdaptiveThinking(model.id)) {
        // Adaptive thinking: Claude decides when and how much to think
        params.thinking = { type: "adaptive" };
        if (options.effort) {
          params.output_config = { effort: options.effort };
        }
      } else {
        // Budget-based thinking for older models
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

interface AnthropicCacheControlAllocator {
  claim(): AnthropicCacheControl | undefined;
  remaining(): number;
}

function createAnthropicCacheControlAllocator(
  cacheControl: AnthropicCacheControl | undefined,
  maxBreakpoints = 4,
): AnthropicCacheControlAllocator {
  let used = 0;
  return {
    claim() {
      if (!cacheControl || used >= maxBreakpoints) {
        return undefined;
      }
      used += 1;
      return cacheControl;
    },
    remaining() {
      return Math.max(0, maxBreakpoints - used);
    },
  };
}

function applySystemCacheBreakpoint(
  system: MessageCreateParamsStreaming["system"] | undefined,
  allocator: AnthropicCacheControlAllocator,
): void {
  if (!Array.isArray(system) || system.length === 0) {
    return;
  }
  const cacheControl = allocator.claim();
  if (!cacheControl) {
    return;
  }
  const lastBlock = system[system.length - 1];
  if (lastBlock?.type === "text") {
    (lastBlock as typeof lastBlock & { cache_control?: AnthropicCacheControl }).cache_control =
      cacheControl;
  }
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
  messages: Message[],
  model: Model<"anthropic-messages">,
  isOAuthToken: boolean,
  cacheControlAllocator?: AnthropicCacheControlAllocator,
  options?: Pick<StreamOptions, "resolveFile">,
): MessageParam[] {
  const params: MessageParam[] = [];

  // Transform messages for cross-provider compatibility
  const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];

    if (msg.role === "user") {
      const blocks: ContentBlockParam[] = [];
      for (const item of resolveUserMessageContent(model, msg.content, options)) {
        if (item.type === "text") {
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(item.text),
          });
          continue;
        }
        if (item.type === "image") {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: item.data,
            },
          });
          continue;
        }
        const documentBlock = buildAnthropicDocumentBlock(item);
        if (documentBlock) {
          blocks.push(documentBlock);
          continue;
        }
        for (const materialized of materializeResolvedUserMessageContentPart(model, item)) {
          if (materialized.type === "text") {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(materialized.text),
            });
            continue;
          }
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: materialized.mimeType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: materialized.data,
            },
          });
        }
      }
      let filteredBlocks = !model?.input.includes("image")
        ? blocks.filter((b) => b.type !== "image")
        : blocks;
      filteredBlocks = filteredBlocks.filter((b) => {
        if (b.type === "text") {
          return b.text.trim().length > 0;
        }
        return true;
      });
      if (filteredBlocks.length === 0) continue;
      params.push({
        role: "user",
        content: filteredBlocks,
      });
    } else if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text),
          });
        } else if (block.type === "thinking") {
          // Redacted thinking: pass the opaque payload back as redacted_thinking
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature!,
            });
            continue;
          }
          if (block.thinking.trim().length === 0) continue;
          // If thinking signature is missing/empty (e.g., from aborted stream),
          // convert to plain text block without <thinking> tags to avoid API rejection
          // and prevent Claude from mimicking the tags in responses
          if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(block.thinking),
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: block.thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0) continue;
      params.push({
        role: "assistant",
        content: blocks,
      });
    } else if (msg.role === "toolResult") {
      // Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
      const toolResults: ContentBlockParam[] = [];

      // Add the current tool result
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertContentBlocks(msg.content),
        is_error: msg.isError,
      });

      // Look ahead for consecutive toolResult messages
      let j = i + 1;
      while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
        const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content),
          is_error: nextMsg.isError,
        });
        j++;
      }

      // Skip the messages we've already processed
      i = j - 1;

      // Add a single user message with all tool results
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  applyMessageCacheBreakpoints(params, cacheControlAllocator);

  return params;
}

function applyMessageCacheBreakpoints(
  messages: MessageParam[],
  allocator: AnthropicCacheControlAllocator | undefined,
): void {
  if (!allocator || allocator.remaining() <= 0) {
    return;
  }
  const userMessageIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userMessageIndexes.length === 0) {
    return;
  }

  const currentUserIndex = userMessageIndexes[userMessageIndexes.length - 1];
  const previousUserIndex =
    userMessageIndexes.length > 1 ? userMessageIndexes[userMessageIndexes.length - 2] : undefined;

  if (previousUserIndex !== undefined) {
    applyCacheControlToMessageBlock(messages[previousUserIndex], "last", allocator);
  }
  applyCacheControlToMessageBlock(messages[currentUserIndex], "first", allocator);
  if (allocator.remaining() > 0) {
    applyCacheControlToMessageBlock(messages[currentUserIndex], "last", allocator);
  }
}

function applyCacheControlToMessageBlock(
  message: MessageParam | undefined,
  position: "first" | "last",
  allocator: AnthropicCacheControlAllocator,
): void {
  if (!message || message.role !== "user") {
    return;
  }
  if (typeof message.content === "string") {
    const cacheControl = allocator.claim();
    if (!cacheControl) {
      return;
    }
    message.content = [
      {
        type: "text",
        text: message.content,
        cache_control: cacheControl,
      },
    ] as any;
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return;
  }
  const indexes =
    position === "first"
      ? message.content.map((_, index) => index)
      : message.content.map((_, index) => index).reverse();
  for (const index of indexes) {
    const block = message.content[index];
    if (!isCacheControlEligibleBlock(block)) {
      continue;
    }
    if ((block as { cache_control?: unknown }).cache_control) {
      return;
    }
    const cacheControl = allocator.claim();
    if (!cacheControl) {
      return;
    }
    (block as typeof block & { cache_control?: AnthropicCacheControl }).cache_control =
      cacheControl;
    return;
  }
}

function isCacheControlEligibleBlock(block: ContentBlockParam | undefined): boolean {
  if (!block) {
    return false;
  }
  return block.type === "text" || block.type === "image" || block.type === "tool_result";
}

function convertTools(
  tools: Tool[],
  isOAuthToken: boolean,
  cacheControlAllocator?: AnthropicCacheControlAllocator,
): Anthropic.Messages.Tool[] {
  if (!tools) return [];

  const converted = tools.map((tool) => {
    const jsonSchema = tool.parameters as any; // TypeBox already generates JSON Schema

    return {
      name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: jsonSchema.properties || {},
        required: jsonSchema.required || [],
      },
    };
  });
  const cacheControl = cacheControlAllocator?.claim();
  if (cacheControl && converted.length > 0) {
    const lastTool = converted[converted.length - 1];
    (lastTool as typeof lastTool & { cache_control?: AnthropicCacheControl }).cache_control =
      cacheControl;
  }
  return converted;
}

export const ANTHROPIC_MESSAGES_TEST_ONLY = {
  buildParams,
  processAnthropicStream,
} as const;

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    case "pause_turn": // Stop is good enough -> resubmit
      return "stop";
    case "stop_sequence":
      return "stop"; // We don't supply stop sequences, so this should never happen
    case "sensitive": // Content flagged by safety filters (not yet in SDK types)
      return "error";
    default:
      // Handle unknown stop reasons gracefully (API may add new values)
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}
