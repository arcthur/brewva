import { runBoundaryOperation } from "@brewva/brewva-effect";
import { BrewvaEffect, BrewvaStream } from "@brewva/brewva-effect/primitives";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessage,
  Context as ProviderContext,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  Model as ProviderModel,
  ProviderPayloadMetadata,
  SimpleStreamOptions as ProviderStreamOptions,
} from "@brewva/brewva-provider-core/contracts";
import { providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import type {
  Message as ProviderMessage,
  ToolCall as ProviderToolCall,
} from "@brewva/brewva-provider-core/contracts";
import {
  type PromptContent,
  type PromptContentPart,
  type PromptMessage,
  type PromptToolCall,
  type RuntimeProviderFrame,
  type RuntimeProviderPort,
  type RuntimeToolAuthorityResolver,
  type RuntimeToolExecutorPort,
  type ToolExecutionResult,
} from "@brewva/brewva-runtime";
import {
  createActionPolicyRegistry,
  getToolActionPolicyForClass,
  resolveToolAuthority,
  type ToolActionAdmissionOverrides,
} from "@brewva/brewva-runtime/protocol";
import { createAsyncBridge, linkAbortSignal } from "@brewva/brewva-std/async";
import { toJsonValue, type JsonValue } from "@brewva/brewva-std/json";
import type {
  BrewvaAgentProtocolAssistantMessage,
  BrewvaAgentProtocolMessage,
  BrewvaAgentProtocolToolCall,
} from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type {
  BrewvaModelPresetState,
  BrewvaModelRoleAlias,
} from "@brewva/brewva-substrate/session";
import type {
  BrewvaToolContext,
  BrewvaToolDefinition,
  BrewvaToolResult,
} from "@brewva/brewva-substrate/tools";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";
import {
  resolveBrewvaModelSelection,
  selectBrewvaFallbackModel,
} from "../../../policy/model-routing/api.js";
import { streamProviderMessage } from "../provider/execution-port.js";
import { isBrewvaModelRoleAlias as isHostedModelRoleAlias } from "../session/settings/model-presets.js";
import type { HostedModelRoutingSettings } from "../session/settings/settings-store.js";
import {
  resolveToolDisplay,
  resolveToolDisplayVerdict,
} from "../session/tools/tool-output-display.js";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { hasHostedPromptAttemptDispatch } from "./hosted-prompt-attempt.js";
import {
  getHostedRuntimeTurnContextMessages,
  hasHostedRuntimeTurnPrelude,
} from "./runtime-turn-prelude.js";

interface RuntimeAdapterSession extends CollectSessionPromptOutputSession {
  readonly model?: BrewvaRegisteredModel;
  getRegisteredTools(): readonly BrewvaToolDefinition[];
  getRuntimeModelCatalog(): {
    getAll?(): readonly BrewvaRegisteredModel[];
    find?(provider: string, id: string): BrewvaRegisteredModel | undefined;
    getApiKeyAndHeaders(
      model: BrewvaRegisteredModel,
    ): Promise<
      { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
    >;
    rotateCredential?(
      provider: string,
      reason: "quota" | "rate_limit" | "auth" | "manual",
      cooldownMs: number,
    ):
      | {
          providerId: string;
          credentialSlot: string;
          reason: "quota" | "rate_limit" | "auth" | "manual";
          cooldownMs: number;
        }
      | undefined;
  };
  getModelPresetState?(): BrewvaModelPresetState;
  getRuntimeActiveModelRole?(): BrewvaModelRoleAlias | undefined;
  getRuntimeModelRoutingSettings?(): HostedModelRoutingSettings | undefined;
  recordRuntimeProviderCredentialRotated?(input: {
    providerId: string;
    credentialSlot: string;
    reason: "quota" | "rate_limit" | "auth" | "manual";
    cooldownMs: number;
  }): void;
  createRuntimeToolContext(): BrewvaToolContext;
  getRuntimeProviderCachePolicy?(): ProviderCachePolicy;
  getRuntimeProviderTransport?(): ProviderStreamOptions["transport"];
  prepareRuntimeProviderPayload?(input: {
    readonly payload: unknown;
    readonly model: ProviderModel<Api>;
    readonly metadata?: ProviderPayloadMetadata;
  }): Promise<unknown>;
  observeRuntimeCacheRender?(input: {
    readonly render: ProviderCacheRenderResult;
    readonly model: ProviderModel<Api>;
  }): void;
  observeRuntimeAssistantMessage?(message: BrewvaAgentProtocolAssistantMessage): void;
}

const DEFAULT_RUNTIME_PROVIDER_CACHE_POLICY: ProviderCachePolicy = {
  retention: "short",
  writeMode: "readWrite",
  scope: "session",
  reason: "default",
};

function resolveRuntimeProviderCachePolicy(session: RuntimeAdapterSession): ProviderCachePolicy {
  return session.getRuntimeProviderCachePolicy?.() ?? DEFAULT_RUNTIME_PROVIDER_CACHE_POLICY;
}

function resolveRuntimeProviderTransport(
  session: RuntimeAdapterSession,
): ProviderStreamOptions["transport"] {
  return session.getRuntimeProviderTransport?.();
}

function isRuntimeAdapterSession(
  session: CollectSessionPromptOutputSession,
): session is RuntimeAdapterSession {
  const candidate = session as Partial<RuntimeAdapterSession>;
  return (
    typeof candidate.getRegisteredTools === "function" &&
    typeof candidate.getRuntimeModelCatalog === "function" &&
    typeof candidate.createRuntimeToolContext === "function"
  );
}

export function canCreateHostedRuntimeExecutionPorts(
  session: CollectSessionPromptOutputSession,
): boolean {
  return (
    isRuntimeAdapterSession(session) &&
    (!hasHostedPromptAttemptDispatch(session) || hasHostedRuntimeTurnPrelude(session))
  );
}

export function createHostedRuntimeToolAuthorityResolver(
  session: CollectSessionPromptOutputSession,
  input: {
    readonly actionAdmissionOverrides?: ToolActionAdmissionOverrides;
  } = {},
): RuntimeToolAuthorityResolver {
  if (!isRuntimeAdapterSession(session)) {
    throw new Error("hosted_runtime_tool_authority_session_incompatible");
  }
  const baseRegistry = createActionPolicyRegistry();
  return (toolName, args) => {
    const base = resolveToolAuthority(toolName, baseRegistry, args, input.actionAdmissionOverrides);
    if (base.source === "exact" || base.source === "registry") {
      return base;
    }
    const tool = session.getRegisteredTools().find((candidate) => candidate.name === toolName);
    const actionClass = getBrewvaToolMetadata(tool)?.actionClass;
    if (!actionClass) {
      return base;
    }
    const registeredToolRegistry = createActionPolicyRegistry();
    registeredToolRegistry.register(toolName, getToolActionPolicyForClass(actionClass));
    return resolveToolAuthority(
      toolName,
      registeredToolRegistry,
      args,
      input.actionAdmissionOverrides,
    );
  };
}

function cloneHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return headers ? { ...headers } : undefined;
}

function toProviderModel(model: BrewvaRegisteredModel): ProviderModel<Api> {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: cloneHeaders(model.headers),
    compat:
      model.api === "openai-completions" || model.api === "openai-responses"
        ? model.compat
        : undefined,
  };
}

function toProviderTools(
  tools: readonly BrewvaToolDefinition[],
): NonNullable<ProviderContext["tools"]> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function providerToolCallFromTurnLoop(part: BrewvaAgentProtocolToolCall): ProviderToolCall {
  return {
    type: "toolCall",
    id: part.id,
    name: part.name,
    arguments: part.arguments,
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
  };
}

function providerMessageFromTurnLoop(message: BrewvaAgentProtocolMessage): ProviderMessage | null {
  if (message.excludeFromContext === true) {
    return null;
  }
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content.map((part) => ({ ...part })),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map((part) =>
        part.type === "toolCall" ? providerToolCallFromTurnLoop(part) : { ...part },
      ),
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseId ? { responseId: message.responseId } : {}),
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        totalTokens: message.usage.totalTokens,
        cost: { ...message.usage.cost },
      },
      stopReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map((part) => ({ ...part })),
      ...(message.details !== undefined ? { details: message.details } : {}),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "custom") {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content.map((part) => ({ ...part }));
    return {
      role: "user",
      content,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "branchSummary") {
    return {
      role: "user",
      content: [{ type: "text", text: message.summary }],
      timestamp: message.timestamp,
    };
  }
  return {
    role: "user",
    content: [{ type: "text", text: message.summary }],
    timestamp: message.timestamp,
  };
}

function textFromPromptContent(content: PromptContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "file") {
        return part.displayText ?? part.name ?? part.uri;
      }
      return "";
    })
    .join("");
}

function clonePromptContentPart(part: PromptContentPart): PromptContentPart {
  return { ...part };
}

function userContentFromPromptContent(
  content: PromptContent,
): Extract<ProviderMessage, { role: "user" }>["content"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((part) => clonePromptContentPart(part));
}

function toolResultContentFromPromptContent(
  content: PromptContent,
): Extract<ProviderMessage, { role: "toolResult" }>["content"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    }
    if (part.type === "image") {
      return { type: "image" as const, data: part.data, mimeType: part.mimeType };
    }
    if (part.type === "file") {
      return {
        type: "text" as const,
        text: part.displayText ?? part.name ?? part.uri,
      };
    }
    return part;
  });
}

function providerToolCallFromPromptToolCall(toolCall: PromptToolCall): ProviderToolCall {
  return {
    type: "toolCall",
    id: toolCall.toolCallId,
    name: toolCall.toolName,
    arguments: toolCall.args ? { ...toolCall.args } : {},
  };
}

function providerMessageFromPromptMessage(message: PromptMessage): ProviderMessage | null {
  if (message.role === "system") {
    return null;
  }
  if (message.role === "user") {
    return {
      role: "user",
      content: userContentFromPromptContent(message.content),
      timestamp: Date.now(),
    };
  }
  if (message.role === "assistant") {
    const text = textFromPromptContent(message.content);
    const toolCalls = message.toolCalls?.map(providerToolCallFromPromptToolCall) ?? [];
    const content: Extract<ProviderMessage, { role: "assistant" }>["content"] = [
      ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
      ...toolCalls,
    ];
    if (content.length === 0) {
      return null;
    }
    return {
      role: "assistant",
      content,
      api: "faux",
      provider: "faux",
      model: "runtime-adapter-history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
  }
  if (!message.toolCallId || !message.toolName) {
    return {
      role: "user",
      content: userContentFromPromptContent(message.content),
      timestamp: Date.now(),
    };
  }
  return {
    role: "toolResult",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: toolResultContentFromPromptContent(message.content),
    isError: message.isError === true,
    timestamp: Date.now(),
  };
}

function toProviderContext(
  session: RuntimeAdapterSession,
  input: Parameters<RuntimeProviderPort["stream"]>[0],
): ProviderContext {
  const toolContext = session.createRuntimeToolContext();
  const systemMessages = input.prompt.messages
    .filter((message) => message.role === "system")
    .map((message) => textFromPromptContent(message.content));
  const systemPrompt = [toolContext.getSystemPrompt(), ...systemMessages]
    .filter((message) => message.trim().length > 0)
    .join("\n\n");
  const messages: ProviderContext["messages"] = [];
  for (const message of input.prompt.messages) {
    const providerMessage = providerMessageFromPromptMessage(message);
    if (providerMessage) {
      messages.push(providerMessage);
    }
  }
  for (const message of getHostedRuntimeTurnContextMessages(session)) {
    const providerMessage = providerMessageFromTurnLoop(message);
    if (providerMessage) {
      messages.push(providerMessage);
    }
  }
  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: userContentFromPromptContent(input.turn.prompt),
      timestamp: Date.now(),
    });
  }
  return {
    systemPrompt,
    messages,
    tools: toProviderTools(session.getRegisteredTools()),
  };
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  const textParts = content.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const type = (item as { type?: unknown }).type;
    if (type !== "text") {
      return [];
    }
    const text = (item as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
  return textParts.join("\n");
}

function toolExecutionResultFromHostedResult(result: BrewvaToolResult): ToolExecutionResult {
  const metadata: Record<string, JsonValue> = {};
  if (result.details !== undefined) {
    metadata.details = toJsonValue(result.details);
  }
  if (result.display !== undefined) {
    metadata.display = toJsonValue(result.display);
  }
  return {
    ok: result.isError !== true,
    content: result.content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function toolExecutionResultFromHostedUpdate(
  toolName: string,
  update: BrewvaToolResult,
): ToolExecutionResult {
  const display = resolveToolDisplay({
    toolName,
    isError: update.isError === true,
    result: update,
  });
  return {
    ok: update.isError !== true,
    content: update.content,
    metadata: {
      verdict: resolveToolDisplayVerdict({
        isError: update.isError === true,
        result: update,
      }),
      ...(display.display ? { display: toJsonValue(display.display) } : {}),
    },
  };
}

function framesFromAssistantMessage(message: AssistantMessage): RuntimeProviderFrame[] {
  const frames: RuntimeProviderFrame[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text.length > 0) {
      frames.push({ type: "text", delta: part.text });
      continue;
    }
    if (part.type === "thinking" && part.thinking.length > 0) {
      frames.push({ type: "reason", delta: part.thinking });
      continue;
    }
    if (part.type === "toolCall") {
      frames.push({
        type: "tool",
        call: {
          toolCallId: part.id,
          toolName: part.name,
          args: part.arguments,
        },
      });
    }
  }
  return frames;
}

function toTurnLoopAssistantMessage(
  message: AssistantMessage,
): BrewvaAgentProtocolAssistantMessage {
  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type === "text") {
        return {
          type: "text" as const,
          text: part.text,
          ...(part.textSignature ? { textSignature: part.textSignature } : {}),
        };
      }
      if (part.type === "thinking") {
        return {
          type: "thinking" as const,
          thinking: part.thinking,
          ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
          ...(part.redacted !== undefined ? { redacted: part.redacted } : {}),
        };
      }
      return {
        type: "toolCall" as const,
        id: part.id,
        name: part.name,
        arguments: part.arguments,
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      };
    }),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      totalTokens: message.usage.totalTokens,
      cost: { ...message.usage.cost },
    },
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
  };
}

type RuntimeProviderQueueItem =
  | { readonly kind: "frame"; readonly frame: RuntimeProviderFrame }
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly error: unknown };

type ProviderFailureReason = "quota" | "rate_limit" | "auth" | "provider" | "context" | "unknown";

class ProviderAttemptError extends Error {
  constructor(
    readonly causeError: unknown,
    readonly sawFrame: boolean,
  ) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = "ProviderAttemptError";
  }
}

function modelKey(model: BrewvaRegisteredModel): string {
  return `${model.provider}/${model.id}`;
}

function classifyProviderFailure(error: unknown): ProviderFailureReason {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/\b(quota|insufficient_quota|billing)\b/u.test(message)) return "quota";
  if (/\b(rate.?limit|429|too many requests)\b/u.test(message)) return "rate_limit";
  if (/\b(auth|api key|unauthorized|forbidden|401|403)\b/u.test(message)) return "auth";
  if (/\b(context|token|maximum context|too long)\b/u.test(message)) return "context";
  if (/\b(provider|upstream|service unavailable|overloaded|timeout|temporar)\b/u.test(message)) {
    return "provider";
  }
  return "unknown";
}

function credentialRotationReason(
  reason: ProviderFailureReason,
): "quota" | "rate_limit" | "auth" | undefined {
  if (reason === "quota" || reason === "rate_limit" || reason === "auth") {
    return reason;
  }
  return undefined;
}

function activePresetFromSession(
  session: RuntimeAdapterSession,
): BrewvaModelPresetState["presets"][number] | undefined {
  const state = session.getModelPresetState?.();
  return state?.presets.find((preset) => preset.name === state.activeName);
}

function resolveModelText(
  session: RuntimeAdapterSession,
  modelText: string,
): BrewvaRegisteredModel | undefined {
  const catalog = session.getRuntimeModelCatalog();
  if (!catalog.getAll) {
    return undefined;
  }
  const selection = resolveBrewvaModelSelection(modelText, {
    getAll: () => [...(catalog.getAll?.() ?? [])],
  });
  return selection.model;
}

function fallbackCandidates(input: {
  session: RuntimeAdapterSession;
  currentModel: BrewvaRegisteredModel;
  attemptedModelKeys: ReadonlySet<string>;
  activeRole: BrewvaModelRoleAlias;
}): BrewvaRegisteredModel[] {
  const catalog = input.session.getRuntimeModelCatalog();
  const availableModels = catalog.getAll?.() ?? [];
  const settings = input.session.getRuntimeModelRoutingSettings?.();
  const activePreset = activePresetFromSession(input.session);
  const candidates: BrewvaRegisteredModel[] = [];
  const push = (model: BrewvaRegisteredModel | undefined) => {
    if (!model) return;
    const key = modelKey(model);
    if (key === modelKey(input.currentModel) || input.attemptedModelKeys.has(key)) return;
    if (candidates.some((candidate) => modelKey(candidate) === key)) return;
    candidates.push(model);
  };
  const chain =
    settings?.fallbackChains[input.activeRole] ?? settings?.fallbackChains.default ?? [];
  for (const entry of chain) {
    const modelText = isHostedModelRoleAlias(entry) ? activePreset?.roles[entry] : entry;
    if (modelText) {
      push(resolveModelText(input.session, modelText));
    }
  }
  if (availableModels.length > 0) {
    push(
      selectBrewvaFallbackModel({
        currentModel: input.currentModel,
        availableModels,
      }),
    );
  }
  return candidates;
}

function providerFallbackMetadata(input: {
  active: boolean;
  attemptedModel: BrewvaRegisteredModel;
  selectedModel: BrewvaRegisteredModel;
  reason: ProviderFailureReason;
  cacheInvalidated?: boolean;
  credentialSlot?: string;
}): Record<string, JsonValue> {
  return {
    active: input.active,
    attemptedRoute: {
      provider: input.attemptedModel.provider,
      model: input.attemptedModel.id,
    },
    selectedRoute: {
      provider: input.selectedModel.provider,
      model: input.selectedModel.id,
      ...(input.credentialSlot ? { credentialSlot: input.credentialSlot } : {}),
    },
    reason: input.reason,
    revertPolicy: "next_turn_uses_active_preset_or_explicit_selection",
    cache_invalidated:
      input.cacheInvalidated ??
      (input.attemptedModel.provider !== input.selectedModel.provider ||
        input.attemptedModel.id !== input.selectedModel.id),
  };
}

function frameFromProviderEvent(event: AssistantMessageEvent): RuntimeProviderFrame | null {
  if (event.type === "text_delta" && event.delta.length > 0) {
    return { type: "text", delta: event.delta };
  }
  if (event.type === "thinking_delta" && event.delta.length > 0) {
    return { type: "reason", delta: event.delta };
  }
  if (event.type === "toolcall_end") {
    return {
      type: "tool",
      call: {
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name,
        args: event.toolCall.arguments,
      },
    };
  }
  return null;
}

async function* streamRuntimeProviderAttempt(
  session: RuntimeAdapterSession,
  input: Parameters<RuntimeProviderPort["stream"]>[0],
  model: BrewvaRegisteredModel,
  providerFallback: Record<string, JsonValue> | undefined,
): AsyncGenerator<RuntimeProviderFrame> {
  const resolvedAuth = await session.getRuntimeModelCatalog().getApiKeyAndHeaders(model);
  if (!resolvedAuth.ok) {
    throw new ProviderAttemptError(
      new Error(`hosted_runtime_provider_auth_failed:${resolvedAuth.error}`),
      false,
    );
  }
  const providerAbort = new AbortController();
  const unlinkAbort = linkAbortSignal(input.turn.signal, providerAbort);
  const options: ProviderStreamOptions = {
    signal: providerAbort.signal,
    apiKey: resolvedAuth.apiKey,
    headers: cloneHeaders(resolvedAuth.headers),
    sessionId: input.turn.sessionId,
    cachePolicy: resolveRuntimeProviderCachePolicy(session),
    transport: resolveRuntimeProviderTransport(session),
    ...(providerFallback ? { metadata: { providerFallback } } : {}),
    onPayload: (payload, providerModel, metadata) =>
      session.prepareRuntimeProviderPayload?.({
        payload,
        model: providerModel,
        metadata,
      }) ?? payload,
    onCacheRender: (render, providerModel) =>
      session.observeRuntimeCacheRender?.({
        render,
        model: providerModel,
      }),
  };
  const providerStream = streamProviderMessage(
    toProviderModel(model),
    toProviderContext(session, input),
    options,
  );
  let sawIncrementalFrame = false;
  const bridge = createAsyncBridge<RuntimeProviderQueueItem>({
    onCancel() {
      providerAbort.abort();
    },
  });
  const consume = runBoundaryOperation(
    "gateway.hosted.provider.consume",
    providerStream.pipe(
      BrewvaStream.runForEach((event) =>
        BrewvaEffect.promise(async () => {
          if (event.type === "error") {
            session.observeRuntimeAssistantMessage?.(toTurnLoopAssistantMessage(event.error));
            await bridge.write({
              kind: "error",
              error: new ProviderAttemptError(
                new Error(event.error.errorMessage ?? "provider_stream_failed"),
                sawIncrementalFrame,
              ),
            });
            return;
          }
          const frame = frameFromProviderEvent(event);
          if (frame) {
            sawIncrementalFrame = true;
            await bridge.write({ kind: "frame", frame });
            return;
          }
          if (event.type === "done") {
            session.observeRuntimeAssistantMessage?.(toTurnLoopAssistantMessage(event.message));
            if (!sawIncrementalFrame) {
              for (const fallback of framesFromAssistantMessage(event.message)) {
                await bridge.write({ kind: "frame", frame: fallback });
              }
            }
          }
        }),
      ),
      BrewvaEffect.provide(providerRuntimeLayer),
    ),
    { signal: providerAbort.signal },
  )
    .then(() => bridge.write({ kind: "done" }))
    .then(() => {
      bridge.close();
    })
    .catch((error) => bridge.fail(new ProviderAttemptError(error, sawIncrementalFrame)));

  try {
    for await (const next of bridge) {
      if (next.kind === "frame") {
        yield next.frame;
        continue;
      }
      if (next.kind === "error") {
        throw next.error;
      }
      break;
    }
  } finally {
    providerAbort.abort();
    unlinkAbort();
    bridge.close();
    void consume.catch(() => undefined);
  }
}

export function createHostedRuntimeProviderPort(
  session: CollectSessionPromptOutputSession,
): RuntimeProviderPort {
  if (!isRuntimeAdapterSession(session)) {
    throw new Error("hosted_runtime_provider_session_incompatible");
  }
  return {
    async *stream(input) {
      const initialModel = session.model;
      if (!initialModel) {
        throw new Error("hosted_runtime_provider_missing_model");
      }
      const activeRole = session.getRuntimeActiveModelRole?.() ?? "default";
      let activeModel = initialModel;
      let fallbackMetadata: Record<string, JsonValue> | undefined;
      const attempted = new Set<string>();
      while (true) {
        attempted.add(modelKey(activeModel));
        try {
          yield* streamRuntimeProviderAttempt(session, input, activeModel, fallbackMetadata);
          return;
        } catch (error) {
          const attemptError =
            error instanceof ProviderAttemptError ? error : new ProviderAttemptError(error, false);
          if (attemptError.sawFrame || input.turn.signal?.aborted === true) {
            throw attemptError.causeError;
          }
          const reason = classifyProviderFailure(attemptError.causeError);
          const rotationReason = credentialRotationReason(reason);
          const rotationSettings = session.getRuntimeModelRoutingSettings?.()?.credentialRotation;
          if (rotationReason && rotationSettings?.enabled === true) {
            const rotation = session
              .getRuntimeModelCatalog()
              .rotateCredential?.(
                activeModel.provider,
                rotationReason,
                rotationSettings.cooldownMs,
              );
            if (rotation) {
              session.recordRuntimeProviderCredentialRotated?.(rotation);
              fallbackMetadata = providerFallbackMetadata({
                active: true,
                attemptedModel: activeModel,
                selectedModel: activeModel,
                reason,
                cacheInvalidated: true,
                credentialSlot: rotation.credentialSlot,
              });
              continue;
            }
          }
          const [nextModel] = fallbackCandidates({
            session,
            currentModel: activeModel,
            attemptedModelKeys: attempted,
            activeRole,
          });
          if (!nextModel) {
            throw attemptError.causeError;
          }
          fallbackMetadata = providerFallbackMetadata({
            active: true,
            attemptedModel: activeModel,
            selectedModel: nextModel,
            reason,
          });
          activeModel = nextModel;
        }
      }
    },
  };
}

export function createHostedRuntimeToolExecutorPort(
  session: CollectSessionPromptOutputSession,
): RuntimeToolExecutorPort {
  if (!isRuntimeAdapterSession(session)) {
    throw new Error("hosted_runtime_tool_executor_session_incompatible");
  }
  return {
    async execute(commitment, input): Promise<ToolExecutionResult> {
      const tool = session
        .getRegisteredTools()
        .find((candidate) => candidate.name === commitment.call.toolName);
      if (!tool) {
        throw new Error(`hosted_runtime_tool_not_found:${commitment.call.toolName}`);
      }
      const rawArgs = commitment.call.args ?? {};
      const preparedArgs = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
      const result = await tool.execute(
        commitment.call.toolCallId,
        preparedArgs,
        input.signal,
        input.onProgress
          ? async (update) => {
              await input.onProgress?.(
                toolExecutionResultFromHostedUpdate(commitment.call.toolName, update),
              );
            }
          : undefined,
        session.createRuntimeToolContext(),
      );
      return toolExecutionResultFromHostedResult(result);
    },
  };
}

export function summarizeRuntimeToolResultContent(content: unknown): string {
  return textFromToolResultContent(content);
}
