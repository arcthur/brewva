import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  ModelCapabilityProfile,
  ModelCapabilityRegistry,
  ModelRequestPatchKind,
  ResolvedModelCapability,
} from "./contracts.js";

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

function raiseToolOutputBudget(
  payload: Record<string, unknown>,
  patchKinds: ModelRequestPatchKind[],
): void {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return;
  }
  const minBudget = 3200;
  const hasSnake = "max_output_tokens" in payload;
  const hasCamel = "maxOutputTokens" in payload;
  if (!hasSnake && !hasCamel) {
    return;
  }
  const currentSnake =
    typeof payload.max_output_tokens === "number" && Number.isFinite(payload.max_output_tokens)
      ? payload.max_output_tokens
      : undefined;
  const currentCamel =
    typeof payload.maxOutputTokens === "number" && Number.isFinite(payload.maxOutputTokens)
      ? payload.maxOutputTokens
      : undefined;
  const current = Math.max(currentSnake ?? 0, currentCamel ?? 0);
  if (current >= minBudget) {
    return;
  }
  if (hasSnake) {
    payload.max_output_tokens = minBudget;
  }
  if (hasCamel) {
    payload.maxOutputTokens = minBudget;
  }
  patchKinds.push("tool_output_budget_raised");
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

  raiseToolOutputBudget(nextPayload, patchKinds);

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
