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
