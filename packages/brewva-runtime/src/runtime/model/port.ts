import type { EventId, RuntimeRecoveryCause, SessionId } from "../runtime-api.js";

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
  /** Event provenance aligned by index with `messages`. */
  readonly messageSourceEventIds: readonly EventId[];
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

export interface ModelMaterializationObservationQuery {
  readonly sessionId?: SessionId;
}

export interface ModelMaterializationObservation {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly sessionId: SessionId;
  readonly status: PromptPlan["status"];
  readonly sourceEventIds: readonly EventId[];
  readonly admittedBlockIds: readonly string[];
  readonly droppedAdvisoryBlockIds: readonly string[];
  readonly tokenEstimate: number;
  readonly cache: PromptPlan["cache"];
  readonly budget?: RuntimeBudget;
}

export interface ModelObservePort {
  readonly materialization: {
    list(query?: ModelMaterializationObservationQuery): readonly ModelMaterializationObservation[];
  };
}

export interface ModelPort {
  readonly observe: ModelObservePort;
  materialize(input: MaterializationInput): Promise<PromptPlan>;
  proposeCheckpoint(input: CheckpointProposalInput): Promise<CheckpointCandidate>;
}
