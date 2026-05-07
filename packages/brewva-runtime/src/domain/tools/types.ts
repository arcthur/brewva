import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaToolCallId, BrewvaToolName } from "../../core/identifiers.js";
import type { EffectAuthorityManifestBasis } from "../governance/api.js";

export type {
  FinishToolCallInput,
  StartToolCallInput,
  ToolAccessDecision,
  ToolAccessExplanation,
  ToolStartAuthorization,
} from "./tool-gate.js";
export type { RecordToolResultInput } from "./tool-invocation-spine.js";

export interface ToolLifecycleEventPayload {
  toolCallId: string;
  toolName: string;
  attempt?: number | null;
  isError?: boolean;
  terminalReason?: string;
  lifecycleFallbackReason?: string;
  executionTraits?: JsonValue | null;
}

export type ToolResultVerdict = "pass" | "fail" | "inconclusive";

export type ToolResultFailureClass =
  | "execution"
  | "invocation_validation"
  | "policy_denied"
  | "shell_syntax"
  | "script_composition";

export interface ToolResultFailureContextPayload {
  args: Record<string, JsonValue>;
  outputText: string;
  failureClass: ToolResultFailureClass | null;
  turn: number;
}

export interface ToolResultRecordedEventPayload {
  toolName: BrewvaToolName;
  toolCallId: BrewvaToolCallId | null;
  verdict: ToolResultVerdict;
  channelSuccess: boolean;
  ledgerId: string;
  effectCommitmentRequestId: string | null;
  outputObservation: Record<string, JsonValue> | null;
  outputArtifact: Record<string, JsonValue> | null;
  outputDistillation: Record<string, JsonValue> | null;
  truthProjection: Record<string, JsonValue> | null;
  verificationProjection: Record<string, JsonValue> | null;
  failureClass: ToolResultFailureClass | null;
  failureContext: ToolResultFailureContextPayload | null;
}

export interface ToolOutputDistilledEventPayload {
  toolCallId: BrewvaToolCallId | null;
  toolName: BrewvaToolName;
  isError: boolean;
  verdict: ToolResultVerdict | null;
  strategy: string;
  rawChars: number;
  rawBytes: number;
  rawTokens: number | null;
  summaryChars: number;
  summaryBytes: number;
  summaryTokens: number | null;
  compressionRatio: number | null;
  truncated: boolean;
  summaryText: string;
  artifactRef: string | null;
}

export interface ToolCallBlockedEventPayload {
  schema: "brewva.tool_call_blocked.v1";
  toolName: string;
  reason: string;
  decision: string | null;
  proposalId: string | null;
  requestId: string | null;
  manifestBasis: EffectAuthorityManifestBasis | null;
  skill?: string | null;
  resolution?: string | null;
}
