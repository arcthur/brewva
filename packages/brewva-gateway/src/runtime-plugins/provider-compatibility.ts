import "@mariozechner/pi-ai";
import {
  MODEL_CAPABILITY_PROFILE_SELECTED_EVENT_TYPE,
  MODEL_REQUEST_PATCHED_EVENT_TYPE,
  TOOL_CALL_NORMALIZATION_FAILED_EVENT_TYPE,
  TOOL_CALL_NORMALIZED_EVENT_TYPE,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import {
  createAssistantMessageEventStream,
  getApiProvider,
  registerApiProvider,
  type Api,
  type ApiProvider,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type StreamOptions,
} from "@mariozechner/pi-ai";
import type {
  ModelCapabilityRegistry,
  ModelRequestPatchKind,
  ToolCallNormalizationFailure,
  ToolCallNormalizationRecord,
} from "./provider-compatibility/contracts.js";
import {
  getHostedProviderSessionBinding,
  registerHostedProviderSessionBinding,
  releaseHostedProviderSessionBinding,
  type HostedProviderSessionBinding,
} from "./provider-compatibility/hosted-provider-session-binding.js";
import { createModelCapabilityRegistry } from "./provider-compatibility/model-capability-registry.js";
import {
  createEmptyUsage,
  createNormalizationFailureMessage,
  normalizeAssistantMessageToolCalls,
} from "./provider-compatibility/tool-call-normalizer.js";

export type {
  ModelCapabilityProfile,
  ModelCapabilityRegistry,
  ModelRequestPatchKind,
  ModelRequestPatchResult,
  ReasoningEffortMode,
  ResolvedModelCapability,
  ThinkingMode,
  ToolCallNormalizationFailure,
  ToolCallNormalizationFailureReason,
  ToolCallNormalizationKind,
  ToolCallNormalizationRecord,
  ToolCallNormalizationResult,
  ToolCallNormalizationSuccess,
  ToolChoiceFormat,
} from "./provider-compatibility/contracts.js";
export { createModelCapabilityRegistry } from "./provider-compatibility/model-capability-registry.js";
export {
  createNormalizationFailureMessage,
  normalizeAssistantMessageToolCalls,
} from "./provider-compatibility/tool-call-normalizer.js";

type OriginalApiProvider = NonNullable<ReturnType<typeof getApiProvider>>;
type CompatibilityStreamOptions = {
  sessionId?: string;
  onPayload?: StreamOptions["onPayload"];
};
type CompatibleOnPayload = (payload: unknown, model: Model<Api>) => unknown;

const BUILTIN_APIS: readonly Api[] = [
  "anthropic-messages",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
] as const;

const installedApiSet = new Set<Api>();
const defaultModelCapabilityRegistry = createModelCapabilityRegistry();

function buildProfileFingerprint(model: Model<Api>, profileId: string): string {
  return `${model.provider}:${model.api}:${model.id}:${profileId}`;
}

function recordModelCapabilitySelection(
  sessionId: string | undefined,
  state: HostedProviderSessionBinding | undefined,
  model: Model<Api>,
  profileId: string,
): void {
  if (!sessionId || !state) {
    return;
  }
  const fingerprint = buildProfileFingerprint(model, profileId);
  if (state.lastProfileFingerprint === fingerprint) {
    return;
  }
  state.lastProfileFingerprint = fingerprint;
  state.runtime.events.record({
    sessionId,
    type: MODEL_CAPABILITY_PROFILE_SELECTED_EVENT_TYPE,
    payload: {
      provider: model.provider,
      api: model.api,
      model: model.id,
      profileId,
    },
  });
}

function recordModelRequestPatched(
  sessionId: string | undefined,
  runtime: BrewvaRuntime | undefined,
  model: Model<Api>,
  profileId: string,
  patchKinds: readonly ModelRequestPatchKind[],
): void {
  if (!sessionId || !runtime || patchKinds.length === 0) {
    return;
  }
  runtime.events.record({
    sessionId,
    type: MODEL_REQUEST_PATCHED_EVENT_TYPE,
    payload: {
      provider: model.provider,
      api: model.api,
      model: model.id,
      profileId,
      patchKinds: [...patchKinds],
    },
  });
}

function recordNormalizedToolCalls(
  sessionId: string | undefined,
  runtime: BrewvaRuntime | undefined,
  model: Model<Api>,
  records: readonly ToolCallNormalizationRecord[],
): void {
  if (!sessionId || !runtime) {
    return;
  }
  for (const record of records) {
    runtime.events.record({
      sessionId,
      type: TOOL_CALL_NORMALIZED_EVENT_TYPE,
      payload: {
        provider: model.provider,
        api: model.api,
        model: model.id,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        source: record.source,
        repairKinds: [...record.repairKinds],
        beforeArguments: record.beforeArguments,
        afterArguments: record.afterArguments,
      },
    });
  }
}

function recordToolCallNormalizationFailure(
  sessionId: string | undefined,
  runtime: BrewvaRuntime | undefined,
  model: Model<Api>,
  failure: ToolCallNormalizationFailure,
): void {
  if (!sessionId || !runtime) {
    return;
  }
  runtime.events.record({
    sessionId,
    type: TOOL_CALL_NORMALIZATION_FAILED_EVENT_TYPE,
    payload: {
      provider: model.provider,
      api: model.api,
      model: model.id,
      reason: failure.reason,
      candidateToolName: failure.candidateToolName,
      diagnostics: failure.diagnostics,
    },
  });
}

function wrapRequestPayload(
  originalOnPayload: StreamOptions["onPayload"],
  model: Model<Api>,
  options: CompatibilityStreamOptions | undefined,
  state: HostedProviderSessionBinding | undefined,
): CompatibleOnPayload {
  return async (payload, requestModel) => {
    const nextPayload =
      (await (originalOnPayload as CompatibleOnPayload | undefined)?.(payload, requestModel)) ??
      payload;

    if (!state) {
      return nextPayload;
    }

    const patchResult = state.registry.patchRequest(model, nextPayload);
    recordModelCapabilitySelection(options?.sessionId, state, model, patchResult.profileId);
    recordModelRequestPatched(
      options?.sessionId,
      state.runtime,
      model,
      patchResult.profileId,
      patchResult.patchKinds,
    );
    return patchResult.payload;
  };
}

function passThroughEvent(
  wrappedStream: ReturnType<typeof createAssistantMessageEventStream>,
  event: AssistantMessageEvent,
): void {
  wrappedStream.push(event);
}

function createProviderWrapper(api: Api, originalProvider: OriginalApiProvider): ApiProvider {
  const wrapStream =
    <TOptions extends CompatibilityStreamOptions>(
      baseStream: (
        model: Model<Api>,
        context: Context,
        options?: TOptions,
      ) => ReturnType<typeof createAssistantMessageEventStream>,
    ) =>
    (model: Model<Api>, context: Context, options?: TOptions) => {
      const sessionId = options?.sessionId;
      const state = getHostedProviderSessionBinding(sessionId);
      const wrappedStream = createAssistantMessageEventStream();
      const wrappedOptions = {
        ...options,
        onPayload: wrapRequestPayload(
          options?.onPayload,
          model,
          options,
          state,
        ) as StreamOptions["onPayload"],
      } as TOptions;

      const originalStream = baseStream(model, context, wrappedOptions);

      void (async () => {
        try {
          for await (const event of originalStream) {
            if (event.type === "done") {
              if (!state) {
                wrappedStream.push(event);
                return;
              }

              const normalized = normalizeAssistantMessageToolCalls({
                message: event.message,
                tools: context.tools,
              });
              if (!normalized.ok) {
                recordToolCallNormalizationFailure(
                  sessionId,
                  state.runtime,
                  model,
                  normalized.failure,
                );
                wrappedStream.push({
                  type: "error",
                  reason: "error",
                  error: createNormalizationFailureMessage(event.message, normalized.failure),
                });
                return;
              }

              if (normalized.changed) {
                recordNormalizedToolCalls(sessionId, state.runtime, model, normalized.records);
              }
              const completionReason =
                normalized.message.stopReason === "toolUse" ? "toolUse" : event.reason;
              wrappedStream.push({
                type: "done",
                reason: completionReason,
                message: normalized.message,
              });
              return;
            }

            if (event.type === "error") {
              wrappedStream.push(event);
              return;
            }

            passThroughEvent(wrappedStream, event);
          }
        } catch (error) {
          const failureMessage: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createEmptyUsage(),
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
            content: [
              {
                type: "text",
                text:
                  error instanceof Error
                    ? error.message
                    : `Provider compatibility failure: ${String(error)}`,
              },
            ],
          };
          wrappedStream.push({
            type: "error",
            reason: "error",
            error: failureMessage,
          });
        }
      })();

      return wrappedStream;
    };

  return {
    api,
    stream: wrapStream(originalProvider.stream),
    streamSimple: wrapStream(originalProvider.streamSimple),
  };
}

export function installHostedProviderCompatibilityLayer(): void {
  for (const api of BUILTIN_APIS) {
    if (installedApiSet.has(api)) {
      continue;
    }
    const originalProvider = getApiProvider(api);
    if (!originalProvider) {
      continue;
    }
    registerApiProvider(createProviderWrapper(api, originalProvider), `brewva:${api}`);
    installedApiSet.add(api);
  }
}

export function registerHostedSessionProviderCompatibility(input: {
  sessionId: string;
  runtime: BrewvaRuntime;
  registry?: ModelCapabilityRegistry;
}): void {
  installHostedProviderCompatibilityLayer();
  registerHostedProviderSessionBinding({
    sessionId: input.sessionId,
    binding: {
      runtime: input.runtime,
      registry: input.registry ?? defaultModelCapabilityRegistry,
    },
  });
}

export function releaseHostedSessionProviderCompatibility(sessionId: string): void {
  releaseHostedProviderSessionBinding(sessionId);
}
