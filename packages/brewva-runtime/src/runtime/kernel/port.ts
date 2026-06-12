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
    /**
     * Optional epoch-ms bound on the whole approval closure. The closure must
     * reach a durable committed result before this instant; any authority
     * touch at or after it on an unconsumed approval-bound commitment
     * resolves to a terminal `approval_request_expired` abort. Absent means
     * the approval stays open until decided, cancelled, or consumed.
     */
    readonly expiresAt?: number;
  };
  readonly verificationGates?: readonly KernelVerificationGatePolicyInput[];
}

export type KernelVerificationGateStatus = "missing" | "stale" | "failed";
export type KernelVerificationGatePosture = "advisory" | "defer" | "abort";

export interface KernelVerificationGatePolicyInput {
  readonly gateId: string;
  readonly adapter: string;
  readonly status: KernelVerificationGateStatus;
  readonly posture: KernelVerificationGatePosture;
  readonly targetRoots: readonly string[];
  readonly patchSetRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reason?: string;
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

export interface ResolveApprovalDecisionInput {
  readonly sessionId: SessionId;
  readonly requestId: string;
}

export type ApprovalDecision = "accept" | "deny" | "cancel";

export interface RecordApprovalDecisionInput {
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly actor: string;
  readonly reason?: string;
}

/**
 * Receipt for the canonical approval decision writer. The kernel stamps the
 * decision timestamp from its own clock and enforces first-writer-wins at
 * write time: a decision against an already-terminal request is still
 * recorded as a durable no-op receipt (`applied: false`) and never changes
 * the authority outcome.
 */
export interface ApprovalDecisionReceipt {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly applied: boolean;
  /** Terminal state that already owned the request when `applied` is false. */
  readonly priorState?: "accepted" | "denied" | "cancelled" | "expired" | "consumed";
  readonly event: CanonicalEvent;
}

export type ToolExecutionOutcome<TOutput = unknown, TError = unknown> =
  | {
      readonly kind: "ok";
      readonly value: TOutput;
    }
  | {
      readonly kind: "err";
      readonly error: TError;
    }
  | {
      readonly kind: "inconclusive";
      readonly reason?: string;
      readonly value?: TOutput;
      readonly evidenceRefs?: readonly string[];
    };

export interface ToolExecutionResult {
  readonly outcome: ToolExecutionOutcome;
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
  /**
   * Canonical argument digest of the proposed call this approval binds to,
   * in the persisted `<algorithm>/v<version>:<hex>` form from
   * `@brewva/brewva-std/tool-call-digest`. Request ids identify the request;
   * this digest identifies the exact arguments the operator decided on.
   */
  readonly argsDigest: string;
  /**
   * Epoch-ms bound carried from the proposing call. Decisions recorded at or
   * after this instant do not bind authority; an unconsumed request reaching
   * it resolves to a terminal expired state at the next authority touch.
   */
  readonly expiresAt?: number;
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
  readonly verificationGate?: KernelVerificationGatePolicyInput;
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
  resolveApprovalDecision(input: ResolveApprovalDecisionInput): Promise<ToolCommitmentDecision>;
  recordApprovalDecision(input: RecordApprovalDecisionInput): ApprovalDecisionReceipt;
  commitToolResult(input: CommitToolResultInput): Promise<ToolCommitReceipt>;
  abortToolCall(input: AbortToolCallInput): Promise<ToolAbortReceipt>;
  recordAdvisoryEvent(input: AdvisoryEventInput): AdvisoryEventReceipt;
  readonly intercept: KernelInterceptPort;
}
