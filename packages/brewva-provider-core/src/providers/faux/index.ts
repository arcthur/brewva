import { estimateTokenCount } from "@brewva/brewva-token-estimation";
import { buildProviderCacheBucketKey, normalizeProviderCachePolicy } from "../../cache/policy.js";
import type {
  AssistantMessage,
  Context,
  FileContent,
  ImageContent,
  Message,
  Model,
  ProviderCacheCapability,
  ProviderCacheRenderResult,
  ProviderEventSink,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "../../contracts/index.js";
import {
  registerExternalApiProvider,
  unregisterApiProviders,
} from "../../registry/api-registry.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import { buildProviderPayloadMetadata } from "../_shared/payload-metadata.js";

const DEFAULT_API = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";
const DEFAULT_MODEL_NAME = "Faux Model";
const DEFAULT_BASE_URL = "http://localhost:0";
const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

const FAUX_CACHE_CAPABILITY: ProviderCacheCapability = {
  strategies: ["implicitPrefix"],
  cacheCounters: "readWrite",
  shortRetention: true,
  longRetention: "1h",
  readOnlyWriteMode: "unsupported",
  reason: "faux_prompt_cache",
};

const DEFAULT_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface FauxModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow?: number;
  maxTokens?: number;
}

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

export function fauxText(text: string): TextContent {
  return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
  return { type: "thinking", thinking };
}

export function fauxToolCall(
  name: string,
  arguments_: ToolCall["arguments"],
  options: { id?: string } = {},
): ToolCall {
  return {
    type: "toolCall",
    id: options.id ?? randomId("tool"),
    name,
    arguments: arguments_,
  };
}

function normalizeFauxAssistantContent(
  content: string | FauxContentBlock | FauxContentBlock[],
): FauxContentBlock[] {
  if (typeof content === "string") {
    return [fauxText(content)];
  }
  return Array.isArray(content) ? content : [content];
}

export function fauxAssistantMessage(
  content: string | FauxContentBlock | FauxContentBlock[],
  options: {
    stopReason?: AssistantMessage["stopReason"];
    errorMessage?: string;
    responseId?: string;
    timestamp?: number;
  } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: normalizeFauxAssistantContent(content),
    api: DEFAULT_API,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL_ID,
    usage: DEFAULT_USAGE,
    stopReason: options.stopReason ?? "stop",
    errorMessage: options.errorMessage,
    responseId: options.responseId,
    timestamp: options.timestamp ?? Date.now(),
  };
}

export type FauxResponseFactory = (
  context: Context,
  options: StreamOptions | undefined,
  state: { callCount: number },
  model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;

export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

export interface RegisterFauxProviderOptions {
  api?: string;
  provider?: string;
  models?: FauxModelDefinition[];
  tokensPerSecond?: number;
  tokenSize?: {
    min?: number;
    max?: number;
  };
}

export interface FauxProviderRegistration {
  api: string;
  models: [Model<string>, ...Model<string>[]];
  getModel(): Model<string>;
  getModel(modelId: string): Model<string> | undefined;
  state: { callCount: number };
  setResponses: (responses: FauxResponseStep[]) => void;
  appendResponses: (responses: FauxResponseStep[]) => void;
  getPendingResponseCount: () => number;
  unregister: () => void;
}

function estimateTokens(text: string): number {
  return estimateTokenCount(text);
}

function randomId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function contentToText(content: Array<TextContent | ImageContent | FileContent>): string {
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "file") {
        return `[file:${block.displayText ?? block.name ?? block.uri}]`;
      }
      return `[image:${block.mimeType}:${block.data.length}]`;
    })
    .join("\n");
}

function assistantContentToText(content: Array<TextContent | ThinkingContent | ToolCall>): string {
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "thinking") {
        return block.thinking;
      }
      return `${block.name}:${JSON.stringify(block.arguments)}`;
    })
    .join("\n");
}

function toolResultToText(message: ToolResultMessage): string {
  return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n");
}

function messageToText(message: Message): string {
  if (message.role === "user") {
    return contentToText(message.content);
  }
  if (message.role === "assistant") {
    return assistantContentToText(message.content);
  }
  return toolResultToText(message);
}

function serializeContext(context: Context): string {
  const parts: string[] = [];
  if (context.systemPrompt) {
    parts.push(`system:${context.systemPrompt}`);
  }
  for (const message of context.messages) {
    parts.push(`${message.role}:${messageToText(message)}`);
  }
  if (context.tools?.length) {
    parts.push(`tools:${JSON.stringify(context.tools)}`);
  }
  return parts.join("\n\n");
}

function commonPrefixLength(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let index = 0;
  while (index < length && a[index] === b[index]) {
    index++;
  }
  return index;
}

function withUsageEstimate(
  message: AssistantMessage,
  context: Context,
  options: StreamOptions | undefined,
  promptCache: Map<string, string>,
): AssistantMessage {
  const promptText = serializeContext(context);
  const promptTokens = estimateTokens(promptText);
  const outputTokens = estimateTokens(assistantContentToText(message.content));
  let input = promptTokens;
  let cacheRead = 0;
  let cacheWrite = 0;
  const sessionId = options?.sessionId;
  const cachePolicy = normalizeProviderCachePolicy(options?.cachePolicy);

  if (sessionId && cachePolicy.retention !== "none" && cachePolicy.writeMode !== "readOnly") {
    const previousPrompt = promptCache.get(sessionId);
    if (previousPrompt) {
      const cachedChars = commonPrefixLength(previousPrompt, promptText);
      cacheRead = estimateTokens(previousPrompt.slice(0, cachedChars));
      cacheWrite = estimateTokens(promptText.slice(cachedChars));
      input = Math.max(0, promptTokens - cacheRead);
    } else {
      cacheWrite = promptTokens;
    }
    promptCache.set(sessionId, promptText);
  }

  return {
    ...message,
    usage: {
      input,
      output: outputTokens,
      cacheRead,
      cacheWrite,
      totalTokens: input + outputTokens + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function buildFauxPayload(context: Context, model: Model<string>): Record<string, unknown> {
  return {
    model: model.id,
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools,
  };
}

function resolveFauxCacheRender(
  model: Model<string>,
  options: StreamOptions | undefined,
): ProviderCacheRenderResult {
  const policy = normalizeProviderCachePolicy(options?.cachePolicy);
  const bucketKey = buildProviderCacheBucketKey({
    provider: model.provider,
    api: model.api,
    model: model.id,
    sessionId: options?.sessionId,
    policy,
  });
  if (policy.retention === "none") {
    return {
      status: "disabled",
      reason: "cache_policy_disabled",
      renderedRetention: "none",
      bucketKey,
      capability: FAUX_CACHE_CAPABILITY,
    };
  }
  if (policy.writeMode === "readOnly") {
    return {
      status: "unsupported",
      reason: "cache_write_mode_read_only_not_supported",
      renderedRetention: "none",
      bucketKey,
      capability: FAUX_CACHE_CAPABILITY,
    };
  }
  return {
    status: "rendered",
    reason: "rendered_faux_prompt_cache",
    renderedRetention: policy.retention,
    bucketKey,
    capability: FAUX_CACHE_CAPABILITY,
  };
}

function splitStringByTokenSize(
  text: string,
  minTokenSize: number,
  maxTokenSize: number,
): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
    const charSize = Math.max(1, tokenSize * 4);
    chunks.push(text.slice(index, index + charSize));
    index += charSize;
  }
  return chunks.length > 0 ? chunks : [""];
}

function cloneMessage(
  message: AssistantMessage,
  api: string,
  provider: string,
  modelId: string,
): AssistantMessage {
  const cloned = structuredClone(message);
  return {
    ...cloned,
    api,
    provider,
    model: modelId,
    timestamp: cloned.timestamp ?? Date.now(),
    usage: cloned.usage ?? DEFAULT_USAGE,
  };
}

function createErrorMessage(
  error: unknown,
  api: string,
  provider: string,
  modelId: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider,
    model: modelId,
    usage: DEFAULT_USAGE,
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function createAbortedMessage(partial: AssistantMessage): AssistantMessage {
  return {
    ...partial,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
}

function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
  if (!tokensPerSecond || tokensPerSecond <= 0) {
    return new Promise((resolve) => queueMicrotask(resolve));
  }
  const delayMs = (estimateTokens(chunk) / tokensPerSecond) * 1000;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function streamWithDeltas(
  stream: ProviderEventSink,
  message: AssistantMessage,
  minTokenSize: number,
  maxTokenSize: number,
  tokensPerSecond: number | undefined,
  signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
  const partial: AssistantMessage = { ...message, content: [] };
  if (signal?.aborted) {
    throw new Error(createAbortedMessage(partial).errorMessage);
  }

  await stream.push({ type: "start", partial: { ...partial } });

  for (let index = 0; index < message.content.length; index++) {
    if (signal?.aborted) {
      throw new Error(createAbortedMessage(partial).errorMessage);
    }

    const block = message.content[index]!;

    if (block.type === "thinking") {
      partial.content = [...partial.content, { type: "thinking", thinking: "" }];
      await stream.push({
        type: "thinking_start",
        contentIndex: index,
        partial: { ...partial },
      });
      for (const chunk of splitStringByTokenSize(block.thinking, minTokenSize, maxTokenSize)) {
        await scheduleChunk(chunk, tokensPerSecond);
        if (signal?.aborted) {
          throw new Error(createAbortedMessage(partial).errorMessage);
        }
        (partial.content[index] as ThinkingContent).thinking += chunk;
        await stream.push({
          type: "thinking_delta",
          contentIndex: index,
          delta: chunk,
          partial: { ...partial },
        });
      }
      await stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: { ...partial },
      });
      continue;
    }

    if (block.type === "text") {
      partial.content = [...partial.content, { type: "text", text: "" }];
      await stream.push({
        type: "text_start",
        contentIndex: index,
        partial: { ...partial },
      });
      for (const chunk of splitStringByTokenSize(block.text, minTokenSize, maxTokenSize)) {
        await scheduleChunk(chunk, tokensPerSecond);
        if (signal?.aborted) {
          throw new Error(createAbortedMessage(partial).errorMessage);
        }
        (partial.content[index] as TextContent).text += chunk;
        await stream.push({
          type: "text_delta",
          contentIndex: index,
          delta: chunk,
          partial: { ...partial },
        });
      }
      await stream.push({
        type: "text_end",
        contentIndex: index,
        content: block.text,
        partial: { ...partial },
      });
      continue;
    }

    partial.content = [
      ...partial.content,
      { type: "toolCall", id: block.id, name: block.name, arguments: {} },
    ];
    await stream.push({
      type: "toolcall_start",
      contentIndex: index,
      partial: { ...partial },
    });
    for (const chunk of splitStringByTokenSize(
      JSON.stringify(block.arguments),
      minTokenSize,
      maxTokenSize,
    )) {
      await scheduleChunk(chunk, tokensPerSecond);
      if (signal?.aborted) {
        throw new Error(createAbortedMessage(partial).errorMessage);
      }
      await stream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: chunk,
        partial: { ...partial },
      });
    }
    (partial.content[index] as ToolCall).arguments = block.arguments;
    await stream.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: block,
      partial: { ...partial },
    });
  }

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `Faux provider returned ${message.stopReason}`);
  }

  return message;
}

export function registerFauxProvider(
  options: RegisterFauxProviderOptions = {},
): FauxProviderRegistration {
  const api = options.api ?? randomId(DEFAULT_API);
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const sourceId = randomId("faux-provider");
  const minTokenSize = Math.max(
    1,
    Math.min(
      options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE,
      options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE,
    ),
  );
  const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
  let pendingResponses: FauxResponseStep[] = [];
  const tokensPerSecond = options.tokensPerSecond;
  const state = { callCount: 0 };
  const promptCache = new Map<string, string>();

  const modelDefinitions = options.models?.length
    ? options.models
    : [
        {
          id: DEFAULT_MODEL_ID,
          name: DEFAULT_MODEL_NAME,
          reasoning: false,
          input: ["text", "image"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ];
  const models = modelDefinitions.map((definition) => ({
    id: definition.id,
    name: definition.name ?? definition.id,
    api,
    provider,
    baseUrl: DEFAULT_BASE_URL,
    reasoning: definition.reasoning ?? false,
    input: definition.input ?? ["text", "image"],
    cost: definition.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: definition.contextWindow ?? 128000,
    maxTokens: definition.maxTokens ?? 16384,
  })) as [Model<string>, ...Model<string>[]];

  const stream: StreamFunction<string, StreamOptions> = (requestModel, context, streamOptions) => {
    const step = pendingResponses.shift();
    state.callCount++;

    return runProviderStream(
      requestModel,
      async ({ stream: sink, output, signal }) => {
        const cacheRender = resolveFauxCacheRender(requestModel, streamOptions);
        await streamOptions?.onCacheRender?.(cacheRender, requestModel);
        const payload = buildFauxPayload(context, requestModel);
        await streamOptions?.onPayload?.(
          payload,
          requestModel,
          buildProviderPayloadMetadata(requestModel, streamOptions, payload, cacheRender),
        );

        if (!step) {
          let message = createErrorMessage(
            new Error("No more faux responses queued"),
            api,
            provider,
            requestModel.id,
          );
          message = withUsageEstimate(message, context, streamOptions, promptCache);
          throw new Error(message.errorMessage);
        }

        const resolved =
          typeof step === "function"
            ? await step(context, streamOptions, state, requestModel)
            : step;
        let message = cloneMessage(resolved, api, provider, requestModel.id);
        message = withUsageEstimate(message, context, streamOptions, promptCache);
        const finalMessage = await streamWithDeltas(
          sink,
          message,
          minTokenSize,
          maxTokenSize,
          tokensPerSecond,
          signal,
        );
        Object.assign(output, finalMessage);
      },
      { signal: streamOptions?.signal, sessionId: streamOptions?.sessionId },
    );
  };

  const streamSimple: StreamFunction<string, SimpleStreamOptions> = (
    streamModel,
    context,
    streamOptions,
  ) => stream(streamModel, context, streamOptions);

  registerExternalApiProvider({ api, stream, streamSimple }, sourceId);

  function getModel(): Model<string>;
  function getModel(requestedModelId: string): Model<string> | undefined;
  function getModel(requestedModelId?: string): Model<string> | undefined {
    if (!requestedModelId) {
      return models[0];
    }
    return models.find((candidate) => candidate.id === requestedModelId);
  }

  return {
    api,
    models,
    getModel,
    state,
    setResponses(responses) {
      pendingResponses = [...responses];
    },
    appendResponses(responses) {
      pendingResponses.push(...responses);
    },
    getPendingResponseCount() {
      return pendingResponses.length;
    },
    unregister() {
      unregisterApiProviders(sourceId);
    },
  };
}
