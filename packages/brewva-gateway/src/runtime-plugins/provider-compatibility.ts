import { randomUUID } from "node:crypto";
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
  validateToolArguments,
  type Api,
  type ApiProvider,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type StreamOptions,
  type Tool,
  type ToolCall,
} from "@mariozechner/pi-ai";

export type ToolCallNormalizationKind =
  | "content_embedded_single_call"
  | "double_stringified_arguments"
  | "provider_wrapper_unwrapped"
  | "primitive_to_object_coercion";

export type ToolCallNormalizationFailureReason =
  | "no_structured_tool_call"
  | "ambiguous_multiple_calls"
  | "unknown_tool"
  | "invalid_arguments"
  | "unsupported_provider_shape";

export interface ToolCallNormalizationRecord {
  toolCallId: string;
  toolName: string;
  source: "tool_call" | "assistant_text";
  repairKinds: ToolCallNormalizationKind[];
  beforeArguments?: unknown;
  afterArguments: Record<string, unknown>;
}

export interface ToolCallNormalizationFailure {
  reason: ToolCallNormalizationFailureReason;
  candidateToolName?: string;
  diagnostics?: Record<string, unknown>;
}

export interface ToolCallNormalizationSuccess {
  ok: true;
  changed: boolean;
  message: AssistantMessage;
  records: ToolCallNormalizationRecord[];
}

export type ToolCallNormalizationResult =
  | ToolCallNormalizationSuccess
  | {
      ok: false;
      failure: ToolCallNormalizationFailure;
    };

export type ToolChoiceFormat = "openai" | "anthropic" | "google" | "omit";
export type ReasoningEffortMode =
  | "unsupported"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ThinkingMode = "unsupported" | "disabled" | "enabled" | "provider_native";

export type ModelRequestPatchKind =
  | "anthropic_named_tool_choice_wrapper_fixed"
  | "unsupported_reasoning_removed"
  | "unsupported_thinking_removed"
  | "temperature_clamped"
  | "codex_parallel_tool_calls_defaulted"
  | "codex_tool_choice_defaulted";

export interface ModelCapabilityProfile {
  id: string;
  match: {
    api?: Api;
    provider?: string;
    modelPattern?: string;
  };
  toolChoiceFormat: ToolChoiceFormat;
  supportsParallelToolCalls: boolean;
  reasoning: {
    supported: boolean;
    defaultMode?: ReasoningEffortMode;
  };
  thinking: {
    supported: boolean;
    defaultMode?: ThinkingMode;
  };
  temperaturePolicy?: {
    min?: number;
    max?: number;
    override?: number;
  };
  requestOmissions?: string[];
}

export interface ResolvedModelCapability {
  profile: ModelCapabilityProfile;
}

export interface ModelRequestPatchResult {
  changed: boolean;
  payload: unknown;
  profileId: string;
  patchKinds: ModelRequestPatchKind[];
}

export interface ModelCapabilityRegistry {
  resolve(model: Model<Api>): ResolvedModelCapability;
  patchRequest(model: Model<Api>, payload: unknown): ModelRequestPatchResult;
}

type HostedSessionProviderState = {
  runtime: BrewvaRuntime;
  registry: ModelCapabilityRegistry;
  lastProfileFingerprint?: string;
};

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

const DEFAULT_MODEL_CAPABILITY_PROFILES: readonly ModelCapabilityProfile[] = [
  {
    id: "anthropic-default",
    match: { api: "anthropic-messages", modelPattern: "*" },
    toolChoiceFormat: "anthropic",
    supportsParallelToolCalls: false,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: true, defaultMode: "provider_native" },
  },
  {
    id: "azure-openai-responses-default",
    match: { api: "azure-openai-responses", modelPattern: "*" },
    toolChoiceFormat: "openai",
    supportsParallelToolCalls: true,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: false, defaultMode: "unsupported" },
  },
  {
    id: "bedrock-default",
    match: { api: "bedrock-converse-stream", modelPattern: "*" },
    toolChoiceFormat: "omit",
    supportsParallelToolCalls: false,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: true, defaultMode: "provider_native" },
  },
  {
    id: "google-default",
    match: { api: "google-generative-ai", modelPattern: "*" },
    toolChoiceFormat: "google",
    supportsParallelToolCalls: true,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: true, defaultMode: "enabled" },
    temperaturePolicy: { min: 0, max: 2 },
  },
  {
    id: "google-gemini-cli-default",
    match: { api: "google-gemini-cli", modelPattern: "*" },
    toolChoiceFormat: "google",
    supportsParallelToolCalls: true,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: true, defaultMode: "enabled" },
    temperaturePolicy: { min: 0, max: 2 },
  },
  {
    id: "google-vertex-default",
    match: { api: "google-vertex", modelPattern: "*" },
    toolChoiceFormat: "google",
    supportsParallelToolCalls: true,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: true, defaultMode: "enabled" },
    temperaturePolicy: { min: 0, max: 2 },
  },
  {
    id: "mistral-default",
    match: { api: "mistral-conversations", modelPattern: "*" },
    toolChoiceFormat: "openai",
    supportsParallelToolCalls: true,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: true, defaultMode: "provider_native" },
  },
  {
    id: "openai-codex-default",
    match: { api: "openai-codex-responses", modelPattern: "*" },
    toolChoiceFormat: "openai",
    supportsParallelToolCalls: true,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: false, defaultMode: "unsupported" },
  },
  {
    id: "openai-completions-default",
    match: { api: "openai-completions", modelPattern: "*" },
    toolChoiceFormat: "openai",
    supportsParallelToolCalls: true,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: false, defaultMode: "unsupported" },
  },
  {
    id: "openai-responses-default",
    match: { api: "openai-responses", modelPattern: "*" },
    toolChoiceFormat: "openai",
    supportsParallelToolCalls: true,
    reasoning: { supported: true, defaultMode: "medium" },
    thinking: { supported: false, defaultMode: "unsupported" },
  },
] as const;

const installedApiSet = new Set<Api>();
const hostedSessionProviderStateBySessionId = new Map<string, HostedSessionProviderState>();
const defaultModelCapabilityRegistry = createModelCapabilityRegistry();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function matchPattern(value: string, pattern: string): boolean {
  if (!pattern || pattern === "*") return true;
  const expression = new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".*")}$`, "i");
  return expression.test(value);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseJsonValue(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function createEmptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function normalizeToolName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getSingleFieldName(tool: Tool): string | undefined {
  if (!isRecord(tool.parameters)) return undefined;
  if (tool.parameters.type !== "object") return undefined;
  const properties = isRecord(tool.parameters.properties) ? tool.parameters.properties : undefined;
  if (!properties) return undefined;
  const keys = Object.keys(properties);
  return keys.length === 1 ? keys[0] : undefined;
}

function unwrapProviderWrapperArguments(value: Record<string, unknown>): {
  changed: boolean;
  args: unknown;
} {
  const wrapperKeys = ["input", "arguments", "args", "parameters", "tool_input"] as const;
  const present = wrapperKeys.filter((key) => key in value);
  const wrapperKey = present[0];
  if (present.length !== 1 || !wrapperKey) {
    return { changed: false, args: value };
  }
  const wrappedValue = value[wrapperKey];
  if (wrappedValue === undefined) {
    return { changed: false, args: value };
  }
  return { changed: true, args: wrappedValue };
}

function normalizeArgumentsValue(
  tool: Tool,
  toolCall: ToolCall,
):
  | {
      ok: true;
      args: Record<string, unknown>;
      repairKinds: ToolCallNormalizationKind[];
    }
  | {
      ok: false;
      failure: ToolCallNormalizationFailure;
    } {
  let candidate: unknown = toolCall.arguments;
  const repairKinds: ToolCallNormalizationKind[] = [];

  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      try {
        candidate = parseJsonValue(trimmed);
        repairKinds.push("double_stringified_arguments");
      } catch {
        candidate = toolCall.arguments;
      }
    }
  }

  if (isRecord(candidate)) {
    const unwrapped = unwrapProviderWrapperArguments(candidate);
    if (unwrapped.changed) {
      candidate = unwrapped.args;
      repairKinds.push("provider_wrapper_unwrapped");
    }
  }

  if (!isRecord(candidate)) {
    const singleFieldName = getSingleFieldName(tool);
    if (!singleFieldName) {
      return {
        ok: false,
        failure: {
          reason: "invalid_arguments",
          candidateToolName: toolCall.name,
          diagnostics: {
            stage: "primitive_to_object",
          },
        },
      };
    }
    candidate = { [singleFieldName]: candidate };
    repairKinds.push("primitive_to_object_coercion");
  }

  try {
    const validatedArgs = validateToolArguments(tool, {
      ...toolCall,
      arguments: candidate as Record<string, unknown>,
    }) as Record<string, unknown>;
    return {
      ok: true,
      args: validatedArgs,
      repairKinds,
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        reason: "invalid_arguments",
        candidateToolName: toolCall.name,
        diagnostics: {
          stage: "validate_arguments",
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                }
              : { message: String(error) },
        },
      },
    };
  }
}

function parseEmbeddedSingleCall(text: string):
  | {
      ok: true;
      toolName: string;
      args: unknown;
    }
  | {
      ok: false;
      failure?: ToolCallNormalizationFailure;
    } {
  const trimmed = stripCodeFence(text);
  if (!trimmed) {
    return { ok: false };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonValue(trimmed);
  } catch {
    return { ok: false };
  }

  if (Array.isArray(parsed)) {
    return {
      ok: false,
      failure: {
        reason: "ambiguous_multiple_calls",
        diagnostics: {
          stage: "parse_embedded_single_call",
          kind: "array_root",
        },
      },
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false };
  }

  const directToolName =
    normalizeToolName(parsed.toolName) ??
    normalizeToolName(parsed.tool_name) ??
    normalizeToolName(parsed.name);
  const directArgs = parsed.args ?? parsed.arguments ?? parsed.input ?? parsed.parameters;
  if (directToolName) {
    return {
      ok: true,
      toolName: directToolName,
      args: directArgs ?? {},
    };
  }

  if (isRecord(parsed.tool)) {
    const nestedToolName =
      normalizeToolName(parsed.tool.name) ??
      normalizeToolName(parsed.tool.toolName) ??
      normalizeToolName(parsed.tool.tool_name);
    if (!nestedToolName) {
      return { ok: false };
    }
    return {
      ok: true,
      toolName: nestedToolName,
      args:
        parsed.tool.args ??
        parsed.tool.arguments ??
        parsed.tool.input ??
        parsed.tool.parameters ??
        {},
    };
  }

  return { ok: false };
}

function normalizeParsedToolCall(
  toolCall: ToolCall,
  toolByName: ReadonlyMap<string, Tool>,
  source: ToolCallNormalizationRecord["source"],
):
  | {
      ok: true;
      changed: boolean;
      toolCall: ToolCall;
      record?: ToolCallNormalizationRecord;
    }
  | {
      ok: false;
      failure: ToolCallNormalizationFailure;
    } {
  const tool = toolByName.get(toolCall.name);
  if (!tool) {
    return {
      ok: false,
      failure: {
        reason: "unknown_tool",
        candidateToolName: toolCall.name,
      },
    };
  }

  const normalizedArguments = normalizeArgumentsValue(tool, toolCall);
  if (!normalizedArguments.ok) {
    return normalizedArguments;
  }

  const changed =
    normalizedArguments.repairKinds.length > 0 ||
    JSON.stringify(normalizedArguments.args) !== JSON.stringify(toolCall.arguments);
  const normalizedToolCall: ToolCall = changed
    ? {
        ...toolCall,
        arguments: normalizedArguments.args,
      }
    : toolCall;

  return {
    ok: true,
    changed,
    toolCall: normalizedToolCall,
    record: changed
      ? {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          source,
          repairKinds: normalizedArguments.repairKinds,
          beforeArguments: toolCall.arguments,
          afterArguments: normalizedArguments.args,
        }
      : undefined,
  };
}

function createNormalizationFailureMessage(
  message: AssistantMessage,
  failure: ToolCallNormalizationFailure,
): AssistantMessage {
  const details = failure.candidateToolName
    ? `${failure.reason}:${failure.candidateToolName}`
    : failure.reason;
  return {
    role: "assistant",
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: message.usage ?? createEmptyUsage(),
    stopReason: "error",
    errorMessage: `tool_call_normalization_failed:${details}`,
    timestamp: Date.now(),
    content: [
      {
        type: "text",
        text: `Tool call normalization failed: ${details}`,
      },
    ],
  };
}

function normalizeExistingToolCalls(
  message: AssistantMessage,
  toolByName: ReadonlyMap<string, Tool>,
): ToolCallNormalizationResult {
  const nextContent: AssistantMessage["content"] = [];
  const records: ToolCallNormalizationRecord[] = [];
  let changed = false;

  for (const block of message.content) {
    if (block.type !== "toolCall") {
      nextContent.push(block);
      continue;
    }

    const normalized = normalizeParsedToolCall(block, toolByName, "tool_call");
    if (!normalized.ok) {
      return {
        ok: false,
        failure: normalized.failure,
      };
    }

    nextContent.push(normalized.toolCall);
    if (normalized.changed) {
      changed = true;
      if (normalized.record) {
        records.push(normalized.record);
      }
    }
  }

  return {
    ok: true,
    changed,
    message: changed ? { ...message, content: nextContent } : message,
    records,
  };
}

function normalizeEmbeddedToolCall(
  message: AssistantMessage,
  toolByName: ReadonlyMap<string, Tool>,
): ToolCallNormalizationResult | null {
  const textIndexes = message.content
    .map((block, index) => ({ block, index }))
    .filter((entry) => entry.block.type === "text");
  const toolCallCount = message.content.filter((block) => block.type === "toolCall").length;

  if (toolCallCount > 0 || textIndexes.length !== 1) {
    return null;
  }

  const textBlock = textIndexes[0]?.block;
  if (!textBlock || textBlock.type !== "text") {
    return null;
  }

  const parsed = parseEmbeddedSingleCall(textBlock.text);
  if (!parsed.ok) {
    if (parsed.failure) {
      return {
        ok: false,
        failure: parsed.failure,
      };
    }
    return null;
  }

  const tool = toolByName.get(parsed.toolName);
  if (!tool) {
    return {
      ok: false,
      failure: {
        reason: "unknown_tool",
        candidateToolName: parsed.toolName,
      },
    };
  }

  const syntheticToolCall: ToolCall = {
    type: "toolCall",
    id: `brewva_norm_${randomUUID().replaceAll("-", "")}`,
    name: parsed.toolName,
    arguments: parsed.args as Record<string, unknown>,
  };
  const normalized = normalizeArgumentsValue(tool, syntheticToolCall);
  if (!normalized.ok) {
    return {
      ok: false,
      failure: normalized.failure,
    };
  }

  const nextContent = message.content
    .map((block) =>
      block === textBlock
        ? ({
            type: "toolCall",
            id: syntheticToolCall.id,
            name: parsed.toolName,
            arguments: normalized.args,
          } satisfies ToolCall)
        : block,
    )
    .filter((block) => !(block.type === "text" && block.text.trim().length === 0));

  return {
    ok: true,
    changed: true,
    message: {
      ...message,
      stopReason: "toolUse",
      content: nextContent,
    },
    records: [
      {
        toolCallId: syntheticToolCall.id,
        toolName: parsed.toolName,
        source: "assistant_text",
        repairKinds: ["content_embedded_single_call", ...normalized.repairKinds],
        afterArguments: normalized.args,
      },
    ],
  };
}

export function normalizeAssistantMessageToolCalls(input: {
  message: AssistantMessage;
  tools?: readonly Tool[];
}): ToolCallNormalizationResult {
  const tools = input.tools ?? [];
  if (tools.length === 0) {
    return {
      ok: true,
      changed: false,
      message: input.message,
      records: [],
    };
  }

  const toolByName = new Map(tools.map((tool) => [tool.name, tool] as const));
  const embeddedNormalized = normalizeEmbeddedToolCall(input.message, toolByName);
  if (embeddedNormalized) {
    return embeddedNormalized;
  }
  return normalizeExistingToolCalls(input.message, toolByName);
}

function clonePayload(value: unknown): unknown {
  return structuredClone(value);
}

function omitPath(target: Record<string, unknown>, path: string): boolean {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;

  let cursor: Record<string, unknown> | undefined = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) {
      return false;
    }
    const next: unknown = cursor?.[segment];
    if (!isRecord(next)) {
      return false;
    }
    cursor = next;
  }

  const leaf = segments[segments.length - 1];
  if (!cursor || !leaf || !(leaf in cursor)) {
    return false;
  }
  delete cursor[leaf];
  return true;
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let current = value;
  if (typeof min === "number" && current < min) current = min;
  if (typeof max === "number" && current > max) current = max;
  return current;
}

function patchRequestPayload(
  profile: ModelCapabilityProfile,
  payload: unknown,
): {
  payload: unknown;
  changed: boolean;
  patchKinds: ModelRequestPatchKind[];
} {
  if (!isRecord(payload)) {
    return { payload, changed: false, patchKinds: [] };
  }

  const nextPayload = clonePayload(payload);
  if (!isRecord(nextPayload)) {
    return { payload, changed: false, patchKinds: [] };
  }

  const patchKinds: ModelRequestPatchKind[] = [];

  for (const omissionPath of profile.requestOmissions ?? []) {
    const omitted = omitPath(nextPayload, omissionPath);
    if (!omitted) continue;
    if (omissionPath.startsWith("reasoning")) {
      patchKinds.push("unsupported_reasoning_removed");
      continue;
    }
    if (omissionPath.startsWith("thinking")) {
      patchKinds.push("unsupported_thinking_removed");
    }
  }

  const toolChoice = toObjectRecord(nextPayload.tool_choice);
  if (
    profile.toolChoiceFormat === "anthropic" &&
    toolChoice?.type === "function" &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === "string"
  ) {
    nextPayload.tool_choice = {
      type: "tool",
      name: toolChoice.function.name,
    };
    patchKinds.push("anthropic_named_tool_choice_wrapper_fixed");
  }

  if (profile.id === "openai-codex-default" && Array.isArray(nextPayload.tools)) {
    if (nextPayload.parallel_tool_calls !== true) {
      nextPayload.parallel_tool_calls = true;
      patchKinds.push("codex_parallel_tool_calls_defaulted");
    }
    if (nextPayload.tool_choice === undefined) {
      nextPayload.tool_choice = "auto";
      patchKinds.push("codex_tool_choice_defaulted");
    }
  }

  if (profile.temperaturePolicy) {
    if (typeof profile.temperaturePolicy.override === "number") {
      if (nextPayload.temperature !== profile.temperaturePolicy.override) {
        nextPayload.temperature = profile.temperaturePolicy.override;
        patchKinds.push("temperature_clamped");
      }
    } else if (typeof nextPayload.temperature === "number") {
      const clamped = clampNumber(
        nextPayload.temperature,
        profile.temperaturePolicy.min,
        profile.temperaturePolicy.max,
      );
      if (clamped !== nextPayload.temperature) {
        nextPayload.temperature = clamped;
        patchKinds.push("temperature_clamped");
      }
    }
  }

  return {
    payload: nextPayload,
    changed: patchKinds.length > 0,
    patchKinds,
  };
}

export function createModelCapabilityRegistry(
  profiles: readonly ModelCapabilityProfile[] = DEFAULT_MODEL_CAPABILITY_PROFILES,
): ModelCapabilityRegistry {
  const orderedProfiles = [...profiles];

  function resolve(model: Model<Api>): ResolvedModelCapability {
    const exact = orderedProfiles.find(
      (profile) =>
        profile.match.provider === model.provider &&
        profile.match.api === model.api &&
        matchPattern(model.id, profile.match.modelPattern ?? "*"),
    );
    if (exact) {
      return { profile: exact };
    }

    const providerAndPattern = orderedProfiles.find(
      (profile) =>
        (profile.match.provider === undefined || profile.match.provider === model.provider) &&
        (profile.match.api === undefined || profile.match.api === model.api) &&
        matchPattern(model.id, profile.match.modelPattern ?? "*"),
    );
    if (providerAndPattern) {
      return { profile: providerAndPattern };
    }

    throw new Error(`No model capability profile resolved for ${model.provider}/${model.id}`);
  }

  return {
    resolve,
    patchRequest(model, payload) {
      const resolved = resolve(model);
      const patched = patchRequestPayload(resolved.profile, payload);
      return {
        changed: patched.changed,
        payload: patched.payload,
        profileId: resolved.profile.id,
        patchKinds: patched.patchKinds,
      };
    },
  };
}

function buildProfileFingerprint(model: Model<Api>, profileId: string): string {
  return `${model.provider}:${model.api}:${model.id}:${profileId}`;
}

function recordModelCapabilitySelection(
  sessionId: string | undefined,
  runtime: BrewvaRuntime | undefined,
  state: HostedSessionProviderState | undefined,
  model: Model<Api>,
  profileId: string,
): void {
  if (!sessionId || !runtime || !state) {
    return;
  }
  const fingerprint = buildProfileFingerprint(model, profileId);
  if (state.lastProfileFingerprint === fingerprint) {
    return;
  }
  state.lastProfileFingerprint = fingerprint;
  runtime.events.record({
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
  state: HostedSessionProviderState | undefined,
): CompatibleOnPayload {
  return async (payload, requestModel) => {
    const nextPayload =
      (await (originalOnPayload as CompatibleOnPayload | undefined)?.(payload, requestModel)) ??
      payload;

    if (!state) {
      return nextPayload;
    }

    const patchResult = state.registry.patchRequest(model, nextPayload);
    recordModelCapabilitySelection(
      options?.sessionId,
      state.runtime,
      state,
      model,
      patchResult.profileId,
    );
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
      const state = sessionId ? hostedSessionProviderStateBySessionId.get(sessionId) : undefined;
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
  hostedSessionProviderStateBySessionId.set(input.sessionId, {
    runtime: input.runtime,
    registry: input.registry ?? defaultModelCapabilityRegistry,
  });
}

export function releaseHostedSessionProviderCompatibility(sessionId: string): void {
  hostedSessionProviderStateBySessionId.delete(sessionId);
}
