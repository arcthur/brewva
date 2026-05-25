import type { JsonValue } from "@brewva/brewva-std/json";
import type { PromptContentPart } from "../model/port.js";
import type { RuntimeRecoveryCause } from "../runtime-api.js";

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
