import type {
  KernelVerificationGatePolicyInput,
  ToolCommitment,
  ToolExecutionResult,
} from "../kernel/port.js";
import type { PromptContent, PromptPlan, RuntimeBudget } from "../model/port.js";
import type { CanonicalEvent, RuntimeRecoveryCause, SessionId } from "../runtime-api.js";

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
  /**
   * Opaque hosted `HarnessManifest` id for audit correlation. The canonical
   * proposal carries the execution-bearing identity separately.
   */
  readonly proposalManifestId?: string;
  /** Canonical hash of the tool identity advertised in this provider attempt. */
  readonly proposalToolIdentityHash?: string;
  readonly verificationGates?: readonly KernelVerificationGatePolicyInput[];
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
  readonly resolveApproval?: {
    readonly requestId: string;
  };
  /**
   * Resumes a turn previously suspended with cause "compaction_required".
   * Carries the suspended turn id so the resumed stream continues that turn
   * without committing a second turn.started. The runtime validates that the
   * session's latest recovery cause is "compaction_required" before resuming.
   */
  readonly resume?: {
    readonly kind: "compaction";
    readonly turnId: string;
  };
  readonly softCut?: {
    /**
     * Polled after each committed tool result. Returning true suspends the
     * turn with cause "compaction_required" at that tool-result boundary so
     * the host can run compaction and resume.
     */
    afterToolResult(): boolean;
  };
}

export type TurnFrame =
  | {
      readonly type: "runtime.suspended";
      readonly cause: Extract<
        RuntimeRecoveryCause,
        "approval_pending" | "interrupt" | "compaction_required"
      >;
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
