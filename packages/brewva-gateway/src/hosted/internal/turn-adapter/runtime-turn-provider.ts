import { runBoundaryOperation } from "@brewva/brewva-effect";
import { BrewvaEffect, BrewvaStream } from "@brewva/brewva-effect/primitives";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessage,
  Model as ProviderModel,
  SimpleStreamOptions as ProviderStreamOptions,
} from "@brewva/brewva-provider-core/contracts";
import { providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import type { RuntimeProviderFrame, RuntimeProviderPort } from "@brewva/brewva-runtime";
import { createAsyncBridge, linkAbortSignal } from "@brewva/brewva-std/async";
import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaAgentProtocolAssistantMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type {
  BrewvaModelPresetState,
  BrewvaModelRoleAlias,
} from "@brewva/brewva-substrate/session";
import {
  resolveBrewvaModelSelection,
  selectBrewvaFallbackModel,
} from "../../../policy/model-routing/api.js";
import { streamProviderMessage } from "../provider/execution-port.js";
import { isBrewvaModelRoleAlias as isHostedModelRoleAlias } from "../session/settings/model-presets.js";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { summarizeProviderContext, toProviderContext } from "./runtime-provider-context.js";
import {
  isRuntimeAdapterSession,
  resolveRuntimeProviderCachePolicy,
  resolveRuntimeProviderTransport,
  type RuntimeAdapterSession,
} from "./runtime-turn-session.js";

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
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
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
  if (
    /\b(context|tokens?|too long)\b/u.test(message) ||
    /maximum allowed input length|maximum context|context length|maximum .*input length|exceeds .*maximum .*context length/u.test(
      message,
    )
  ) {
    return "context";
  }
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
  const providerContext = toProviderContext(session, input);
  const providerContextSummary = summarizeProviderContext(providerContext);
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
        turn: {
          sessionId: input.turn.sessionId,
          ...(input.turn.turnId ? { turnId: input.turn.turnId } : {}),
        },
        providerContext: providerContextSummary,
      }) ?? payload,
    onCacheRender: (render, providerModel) =>
      session.observeRuntimeCacheRender?.({
        render,
        model: providerModel,
      }),
  };
  const providerStream = streamProviderMessage(toProviderModel(model), providerContext, options);
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
