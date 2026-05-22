import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaConfig } from "../config/types.js";
import type { DeepReadonly } from "../core/deep-readonly.js";
import type { ResolvedToolAuthority } from "./kernel/policy/public-contract.js";

export type RuntimeToolAuthorityResolver = (
  toolName: string,
  args?: Record<string, unknown>,
) => ResolvedToolAuthority;

export interface BrewvaRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  agentId?: string;
  provider?: RuntimeProviderPort;
  toolExecutor?: RuntimeToolExecutorPort;
  resolveToolAuthority?: RuntimeToolAuthorityResolver;
}

export interface BrewvaRuntimeIdentity {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
}

export type SessionId = string;
export type EventId = string;

export const CANONICAL_EVENT_TYPES = [
  "turn.started",
  "turn.ended",
  "msg.committed",
  "reason.committed",
  "tool.proposed",
  "tool.committed",
  "tool.aborted",
  "checkpoint.committed",
  "anchor.committed",
  "approval.requested",
  "approval.decided",
  "cost.observed",
  "runtime.suspended",
  "custom",
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export const RUNTIME_RECOVERY_CAUSES = [
  "approval_pending",
  "compaction_required",
  "provider_retry",
  "interrupt",
  "terminal_commit",
] as const;

export type RuntimeRecoveryCause = (typeof RUNTIME_RECOVERY_CAUSES)[number];

export interface ToolAuthorityDecisionPayload {
  readonly normalizedToolName: string;
  readonly source: ResolvedToolAuthority["source"];
  readonly boundary: ResolvedToolAuthority["boundary"];
  readonly requiresApproval: boolean;
  readonly actionClass?: ResolvedToolAuthority["actionClass"];
  readonly riskLevel?: ResolvedToolAuthority["riskLevel"];
  readonly defaultAdmission?: ResolvedToolAuthority["defaultAdmission"];
  readonly maxAdmission?: ResolvedToolAuthority["maxAdmission"];
  readonly effectiveAdmission?: ResolvedToolAuthority["effectiveAdmission"];
  readonly effects: readonly string[];
  readonly recoveryPreparation: ResolvedToolAuthority["recoveryPreparation"];
  readonly receiptPolicy?: ResolvedToolAuthority["receiptPolicy"];
  readonly recoveryPolicy?: ResolvedToolAuthority["recoveryPolicy"];
  readonly policyBasis: readonly string[];
}

export interface CustomEventPayload {
  readonly namespace: string;
  readonly kind: string;
  readonly version: number;
  readonly authority: "none" | "advisory";
  readonly payload: JsonValue;
}

export interface CanonicalEventBase<TType extends CanonicalEventType, TPayload> {
  readonly id: EventId;
  readonly sessionId: SessionId;
  readonly type: TType;
  readonly timestamp: number;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly payload?: TPayload;
}

export interface TurnStartedPayload {
  readonly prompt: string;
  readonly content: readonly PromptContentPart[];
  readonly mode?: string;
}

export interface TurnEndedPayload {
  readonly cause: Extract<RuntimeRecoveryCause, "terminal_commit">;
  readonly status?: "completed" | "failed" | "cancelled";
  readonly error?: string;
}

export interface TextCommittedPayload {
  readonly text: string;
}

export interface ToolProposedPayload {
  readonly commitmentId: string;
  readonly call: ToolCallProposal;
  readonly authority: ToolAuthorityDecisionPayload;
}

export interface ToolCommittedPayload {
  readonly commitmentId: string;
  readonly call: ToolCallProposal;
  readonly result: ToolExecutionResult;
}

export interface ToolAbortedPayload {
  readonly commitmentId: string;
  readonly reason: string;
  readonly call?: ToolCallProposal;
  readonly attemptedCall?: ToolCallProposal;
  readonly authority?: ToolAuthorityDecisionPayload;
}

export interface CheckpointCommittedPayload {
  readonly sessionId: SessionId;
  readonly summary: string;
  readonly sourceEventIds: readonly EventId[];
  readonly eventCount: number;
  readonly cause: Extract<RuntimeRecoveryCause, "compaction_required">;
}

export interface AnchorCommittedPayload {
  readonly label?: string;
  readonly payload?: JsonValue;
}

export interface ApprovalRequestedPayload extends ApprovalRequest {
  readonly authority: ToolAuthorityDecisionPayload;
}

export interface ApprovalDecidedPayload {
  readonly id: string;
  readonly decision: "approve" | "decline";
  readonly actor?: string;
  readonly reason?: string;
}

export interface CostObservedPayload {
  readonly provider?: string;
  readonly model?: string;
  readonly currency?: string;
  readonly amount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly metadata?: Record<string, JsonValue>;
}

export interface RuntimeSuspendedPayload {
  readonly cause: Extract<
    RuntimeRecoveryCause,
    "approval_pending" | "provider_retry" | "interrupt"
  >;
  readonly commitmentId?: string;
  readonly approvalRequestId?: string;
  readonly error?: string;
}

export type CanonicalEvent =
  | CanonicalEventBase<"turn.started", TurnStartedPayload>
  | CanonicalEventBase<"turn.ended", TurnEndedPayload>
  | CanonicalEventBase<"msg.committed", TextCommittedPayload>
  | CanonicalEventBase<"reason.committed", TextCommittedPayload>
  | CanonicalEventBase<"tool.proposed", ToolProposedPayload>
  | CanonicalEventBase<"tool.committed", ToolCommittedPayload>
  | CanonicalEventBase<"tool.aborted", ToolAbortedPayload>
  | CanonicalEventBase<"checkpoint.committed", CheckpointCommittedPayload>
  | CanonicalEventBase<"anchor.committed", AnchorCommittedPayload>
  | CanonicalEventBase<"approval.requested", ApprovalRequestedPayload>
  | CanonicalEventBase<"approval.decided", ApprovalDecidedPayload>
  | CanonicalEventBase<"cost.observed", CostObservedPayload>
  | CanonicalEventBase<"runtime.suspended", RuntimeSuspendedPayload>
  | CanonicalEventBase<"custom", CustomEventPayload>;

export type CanonicalEventFor<TType extends CanonicalEventType> = Extract<
  CanonicalEvent,
  { readonly type: TType }
>;

export type CanonicalEventCommitInput = CanonicalEvent extends infer TEvent
  ? TEvent extends CanonicalEvent
    ? Omit<TEvent, "id" | "timestamp"> & Partial<Pick<TEvent, "id" | "timestamp">>
    : never
  : never;

export interface TapeQuery {
  readonly type?: CanonicalEventType;
  readonly last?: number;
  readonly after?: number;
  readonly before?: number;
  readonly offset?: number;
  readonly limit?: number;
}

export interface Baseline {
  readonly sessionId: SessionId;
  readonly checkpoint: CanonicalEvent | null;
  readonly events: readonly CanonicalEvent[];
}

export type TapeViewName =
  | "turn_state"
  | "tool_commitments"
  | "recovery_history"
  | "cost_summary"
  | "baseline";

export interface TurnStateView {
  readonly sessionId: SessionId;
  readonly active: boolean;
  readonly lastCause: RuntimeRecoveryCause | null;
  readonly lastEvent: CanonicalEvent | null;
}

export interface ToolCommitmentsView {
  readonly sessionId: SessionId;
  readonly proposed: readonly CanonicalEvent[];
  readonly committed: readonly CanonicalEvent[];
  readonly aborted: readonly CanonicalEvent[];
}

export interface RecoveryHistoryView {
  readonly sessionId: SessionId;
  readonly causes: readonly RuntimeRecoveryCause[];
}

export interface CostSummaryView {
  readonly sessionId: SessionId;
  readonly events: readonly CanonicalEvent[];
}

export interface BaselineView extends Baseline {}

export type TapeView<TName extends TapeViewName> = TName extends "turn_state"
  ? TurnStateView
  : TName extends "tool_commitments"
    ? ToolCommitmentsView
    : TName extends "recovery_history"
      ? RecoveryHistoryView
      : TName extends "cost_summary"
        ? CostSummaryView
        : BaselineView;

export interface TapePort {
  list(sessionId: SessionId, query?: TapeQuery): readonly CanonicalEvent[];
  project<TName extends TapeViewName>(sessionId: SessionId, name: TName): TapeView<TName>;
  replayBaseline(sessionId: SessionId): Baseline;
}

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

export interface KernelPort {
  beginToolCall(call: ToolCallProposal): Promise<ToolCommitmentDecision>;
  commitToolResult(input: CommitToolResultInput): Promise<ToolCommitReceipt>;
  abortToolCall(input: AbortToolCallInput): Promise<ToolAbortReceipt>;
  recordAdvisoryEvent(input: AdvisoryEventInput): AdvisoryEventReceipt;
}

export interface MaterializationInput {
  readonly sessionId: SessionId;
  readonly budget?: RuntimeBudget;
}

export interface RuntimeBudget {
  readonly maxInputTokens?: number;
}

export interface PromptTextContentPart {
  readonly type: "text";
  readonly text: string;
}

export interface PromptImageContentPart {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PromptFileContentPart {
  readonly type: "file";
  readonly uri: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly displayText?: string;
}

export type PromptContentPart =
  | PromptTextContentPart
  | PromptImageContentPart
  | PromptFileContentPart;

export type PromptContent = string | readonly PromptContentPart[];

export interface PromptPlan {
  readonly status: "ready" | "over_window";
  readonly sessionId: SessionId;
  readonly messages: readonly PromptMessage[];
  readonly admittedBlocks: readonly PromptBlock[];
  readonly droppedAdvisoryBlocks: readonly PromptBlock[];
  readonly tokenEstimate: number;
  readonly cache: {
    readonly stablePrefix: boolean;
  };
}

export interface PromptToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: Record<string, unknown>;
}

export interface PromptMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: PromptContent;
  readonly toolCalls?: readonly PromptToolCall[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

export interface PromptBlock {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly required: boolean;
}

export interface CheckpointProposalInput {
  readonly sessionId: SessionId;
  readonly budget?: RuntimeBudget;
  readonly reason: Extract<RuntimeRecoveryCause, "compaction_required">;
}

export interface CheckpointCandidate {
  readonly sessionId: SessionId;
  readonly summary: string;
  readonly sourceEventIds: readonly EventId[];
  readonly eventCount: number;
}

export interface ModelPort {
  materialize(input: MaterializationInput): Promise<PromptPlan>;
  proposeCheckpoint(input: CheckpointProposalInput): Promise<CheckpointCandidate>;
}

export interface RuntimeStartReceipt {
  readonly recoveredSessions: readonly SessionId[];
}

export interface RuntimeProviderInput {
  readonly turn: TurnInput;
  readonly prompt: PromptPlan;
}

export type RuntimeProviderFrame =
  | {
      readonly type: "text";
      readonly delta: string;
    }
  | {
      readonly type: "reason";
      readonly delta: string;
    }
  | {
      readonly type: "tool";
      readonly call: RuntimeProviderToolCall;
    };

export interface RuntimeProviderToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: Record<string, unknown>;
  readonly cwd?: string;
  readonly approval?: {
    readonly required: boolean;
    readonly reason: string;
  };
}

export interface RuntimeProviderPort {
  stream(input: RuntimeProviderInput): AsyncIterable<RuntimeProviderFrame>;
}

export interface RuntimeToolExecutorInput {
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: ToolExecutionResult) => Promise<void>;
}

export interface RuntimeToolExecutorPort {
  execute(
    commitment: ToolCommitment,
    input: RuntimeToolExecutorInput,
  ): Promise<ToolExecutionResult>;
}

export interface TurnInput {
  readonly sessionId: SessionId;
  readonly turnId?: string;
  readonly prompt: PromptContent;
  readonly mode?: string;
  readonly budget?: RuntimeBudget;
  readonly signal?: AbortSignal;
}

export type TurnFrame =
  | {
      readonly type: "runtime.suspended";
      readonly cause: Extract<RuntimeRecoveryCause, "approval_pending" | "interrupt">;
    }
  | {
      readonly type: "runtime.event";
      readonly event: CanonicalEvent;
    }
  | {
      readonly type: "tool.progress";
      readonly progress: {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly update: ToolExecutionResult;
      };
    }
  | {
      readonly type: "reason";
      readonly delta: string;
    }
  | {
      readonly type: "text";
      readonly delta: string;
    };

export interface BrewvaRuntime {
  readonly identity: BrewvaRuntimeIdentity;
  readonly config: DeepReadonly<BrewvaConfig>;
  readonly tape: TapePort;
  readonly kernel: KernelPort;
  readonly model: ModelPort;
  start(): Promise<RuntimeStartReceipt>;
  turn(input: TurnInput): AsyncIterable<TurnFrame>;
  close(): Promise<void>;
}

export interface TapeCommitPort {
  commit(event: CanonicalEventCommitInput): CanonicalEvent;
}
