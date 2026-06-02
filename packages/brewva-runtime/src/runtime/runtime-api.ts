import type { BrewvaConfig } from "../config/types.js";
import type { DeepReadonly } from "../core/deep-readonly.js";
import type {
  ApprovalDecidedPayload,
  ApprovalRequestedPayload,
  ToolAbortedPayload,
  ToolCommittedPayload,
  ToolProposedPayload,
} from "./kernel/events.js";
import type { ResolvedToolAuthority } from "./kernel/policy/public-contract.js";
import type { KernelPort } from "./kernel/port.js";
import type { CheckpointCommittedPayload } from "./model/events.js";
import type { ModelPort } from "./model/port.js";
import type { AnchorCommittedPayload, CustomEventPayload } from "./tape/events.js";
import type { TapePort } from "./tape/port.js";
import type {
  CostObservedPayload,
  RuntimeSuspendedPayload,
  TextCommittedPayload,
  TurnEndedPayload,
  TurnStartedPayload,
} from "./turn/events.js";
import type {
  RuntimeProviderPort,
  RuntimeToolExecutorPort,
  TurnFrame,
  TurnInput,
} from "./turn/port.js";

export type {
  ApprovalDecidedPayload,
  ApprovalRequestedPayload,
  ToolAbortedPayload,
  ToolAuthorityDecisionPayload,
  ToolCommittedPayload,
  ToolProposedPayload,
} from "./kernel/events.js";
export type {
  AbortToolCallInput,
  AdvisoryEventInput,
  AdvisoryEventReceipt,
  ApprovalRequest,
  ApprovalRequestInput,
  CommitToolResultInput,
  KernelInterceptPort,
  KernelInterceptorRegistration,
  KernelPort,
  KernelShadowEvidenceEntry,
  KernelShadowEvidenceQuery,
  KernelShadowToolAuthorityInput,
  KernelShadowToolAuthorityPhysics,
  KernelToolAuthorityDecisionEvidence,
  KernelVerificationGatePolicyInput,
  KernelVerificationGatePosture,
  KernelVerificationGateStatus,
  ResolveApprovalDecisionInput,
  ToolAbortReceipt,
  ToolCallProposal,
  ToolCommitment,
  ToolCommitmentDecision,
  ToolCommitReceipt,
  ToolExecutionOutcome,
  ToolExecutionResult,
  ToolExecutionResultContent,
} from "./kernel/port.js";
export type { CheckpointCommittedPayload } from "./model/events.js";
export type {
  CheckpointCandidate,
  CheckpointProposalInput,
  MaterializationInput,
  ModelMaterializationObservation,
  ModelMaterializationObservationQuery,
  ModelObservePort,
  ModelPort,
  PromptBlock,
  PromptContent,
  PromptContentPart,
  PromptFileContentPart,
  PromptImageContentPart,
  PromptMessage,
  PromptPlan,
  PromptTextContentPart,
  PromptToolCall,
  RuntimeBudget,
} from "./model/port.js";
export type { AnchorCommittedPayload, CustomEventPayload } from "./tape/events.js";
export type {
  Baseline,
  BaselineView,
  CostSummaryView,
  RecoveryHistoryView,
  StepProjectionAuthority,
  StepProjectionRecord,
  StepProjectionStatus,
  StepProjectionView,
  TapeCommitPort,
  TapePort,
  TapeQuery,
  TapeView,
  TapeViewName,
  ToolCommitmentsView,
  TurnStateView,
} from "./tape/port.js";
export type {
  CostObservedPayload,
  RuntimeSuspendedPayload,
  TextCommittedPayload,
  TurnEndedPayload,
  TurnStartedPayload,
} from "./turn/events.js";
export type {
  RuntimeProviderFrame,
  RuntimeProviderInput,
  RuntimeProviderPort,
  RuntimeProviderToolCall,
  RuntimeToolExecutorInput,
  RuntimeToolExecutorPort,
  TurnFrame,
  TurnInput,
} from "./turn/port.js";

export type RuntimeToolAuthorityResolver = (
  toolName: string,
  args?: Record<string, unknown>,
) => ResolvedToolAuthority;

export type SessionId = string;
export type EventId = string;

export interface RuntimeReplaySource {
  readonly events: readonly CanonicalEvent[];
  readonly sessionId?: SessionId;
}

export interface RuntimeReplayTarget {
  readonly sessionId: SessionId;
  readonly forkTag?: string;
}

export type RuntimePhysicsDeclaration =
  | {
      readonly mode: "real";
      readonly provider: RuntimeProviderPort;
      readonly toolExecutor: RuntimeToolExecutorPort;
      readonly resolveToolAuthority?: RuntimeToolAuthorityResolver;
    }
  | {
      readonly mode: "replay";
      readonly source: RuntimeReplaySource;
    }
  | {
      readonly mode: "replay-then-real";
      readonly source: RuntimeReplaySource;
      readonly divergeAt: EventId;
      readonly target: RuntimeReplayTarget;
      readonly provider: RuntimeProviderPort;
      readonly toolExecutor: RuntimeToolExecutorPort;
      readonly resolveToolAuthority?: RuntimeToolAuthorityResolver;
    }
  | {
      readonly mode: "noop";
    };

export interface BrewvaRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  agentId?: string;
  physics: RuntimePhysicsDeclaration;
}

export interface BrewvaRuntimeIdentity {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
}

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

export interface CanonicalEventBase<TType extends CanonicalEventType, TPayload> {
  readonly id: EventId;
  readonly sessionId: SessionId;
  readonly type: TType;
  readonly timestamp: number;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly payload?: TPayload;
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

export interface RuntimeStartReceipt {
  readonly recoveredSessions: readonly SessionId[];
}

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
