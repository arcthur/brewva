import type { JsonValue } from "@brewva/brewva-std/json";
import type { PromptContentPart } from "../model/port.js";
import type { CanonicalEvent, EventId, SessionId } from "../runtime-api.js";
import type { RuntimeToolAuthorityResolver } from "../runtime-api.js";
import type { ToolAuthorityDecisionPayload } from "./events.js";

export interface ToolCallProposal {
  readonly sessionId: SessionId;
  readonly turnId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: Record<string, unknown>;
  readonly cwd?: string;
  readonly approval?: {
    readonly required: boolean;
    readonly reason: string;
  };
}

export type ToolCommitmentDecision =
  | {
      readonly kind: "allow";
      readonly commitment: ToolCommitment;
      readonly events: readonly CanonicalEvent[];
    }
  | {
      readonly kind: "block";
      readonly commitmentId: string;
      readonly reason: string;
      readonly events: readonly CanonicalEvent[];
    }
  | {
      readonly kind: "defer";
      readonly commitmentId: string;
      readonly request: ApprovalRequest;
      readonly events: readonly CanonicalEvent[];
    };

export interface ToolCommitment {
  readonly id: string;
  readonly call: ToolCallProposal;
}

export interface CommitToolResultInput {
  readonly commitmentId: string;
  readonly result: ToolExecutionResult;
}

export interface ToolExecutionResult {
  readonly ok: boolean;
  readonly content: ToolExecutionResultContent;
  readonly metadata?: Record<string, JsonValue>;
}

export type ToolExecutionResultContent = string | readonly PromptContentPart[] | JsonValue;

export interface ToolCommitReceipt {
  readonly commitmentId: string;
  readonly event: CanonicalEvent;
}

export interface AbortToolCallInput {
  readonly commitmentId: string;
  readonly reason: string;
}

export interface ToolAbortReceipt {
  readonly commitmentId: string;
  readonly event: CanonicalEvent;
}

export interface ApprovalRequestInput {
  readonly sessionId: SessionId;
  readonly turnId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly reason: string;
}

export interface ApprovalRequest extends ApprovalRequestInput {
  readonly id: string;
}

export interface AdvisoryEventInput {
  readonly sessionId: SessionId;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly id?: EventId;
  readonly timestamp?: number;
  readonly namespace: string;
  readonly kind: string;
  readonly version: number;
  readonly payload: JsonValue;
}

export interface AdvisoryEventReceipt {
  readonly event: CanonicalEvent;
}

export interface KernelShadowToolAuthorityPhysics {
  readonly resolveToolAuthority: RuntimeToolAuthorityResolver;
}

export interface KernelShadowToolAuthorityInput {
  readonly id: string;
  readonly shadowPhysics: KernelShadowToolAuthorityPhysics;
}

export interface KernelInterceptorRegistration {
  unregister(): void;
}

export interface KernelShadowEvidenceQuery {
  readonly sessionId?: SessionId;
  readonly interceptorId?: string;
}

export interface KernelToolAuthorityDecisionEvidence {
  readonly kind: "allow" | "block" | "defer";
  readonly reason?: string;
  readonly eventIds?: readonly EventId[];
  readonly authority?: ToolAuthorityDecisionPayload;
}

export interface KernelShadowEvidenceEntry {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly mode: "shadow";
  readonly stage: "tool.authority";
  readonly interceptorId: string;
  readonly sessionId: SessionId;
  readonly turnId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly real: KernelToolAuthorityDecisionEvidence;
  readonly shadow?: KernelToolAuthorityDecisionEvidence;
  readonly error?: string;
}

export interface KernelInterceptPort {
  shadowToolAuthority(input: KernelShadowToolAuthorityInput): KernelInterceptorRegistration;
  readonly evidence: {
    list(query?: KernelShadowEvidenceQuery): readonly KernelShadowEvidenceEntry[];
  };
}

export interface KernelPort {
  beginToolCall(call: ToolCallProposal): Promise<ToolCommitmentDecision>;
  commitToolResult(input: CommitToolResultInput): Promise<ToolCommitReceipt>;
  abortToolCall(input: AbortToolCallInput): Promise<ToolAbortReceipt>;
  recordAdvisoryEvent(input: AdvisoryEventInput): AdvisoryEventReceipt;
  readonly intercept: KernelInterceptPort;
}
