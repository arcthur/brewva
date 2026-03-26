import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";

export type ToolCallNormalizationKind =
  | "content_embedded_single_call"
  | "double_stringified_arguments"
  | "truncated_json_closed"
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
  | "tool_output_budget_raised"
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
