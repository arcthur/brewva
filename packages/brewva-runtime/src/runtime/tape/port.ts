import type { JsonValue } from "@brewva/brewva-std/json";
import type {
  CanonicalEvent,
  CanonicalEventCommitInput,
  CanonicalEventType,
  RuntimeRecoveryCause,
  SessionId,
} from "../runtime-api.js";

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
  | "step_projection"
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

export type StepProjectionStatus = "proposed" | "committed" | "aborted";

export interface StepProjectionAuthority {
  readonly effects: readonly string[];
  readonly actionClass?: string;
  readonly receiptPolicy?: JsonValue;
  readonly recoveryPolicy?: JsonValue;
  readonly source?: string;
  readonly boundary?: string;
}

export interface StepProjectionRecord {
  readonly stepId: string;
  readonly commitmentId: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly turnId?: string;
  readonly status: StepProjectionStatus;
  readonly proposedEventId?: string;
  readonly committedEventId?: string;
  readonly abortedEventId?: string;
  readonly inputHash?: string;
  readonly outputHash?: string;
  readonly outcomeKind?: "ok" | "err" | "inconclusive";
  readonly outcomeVersion?: string;
  readonly authority?: StepProjectionAuthority;
}

export interface StepProjectionView {
  readonly sessionId: SessionId;
  readonly steps: readonly StepProjectionRecord[];
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
    : TName extends "step_projection"
      ? StepProjectionView
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

export interface TapeCommitPort {
  commit(event: CanonicalEventCommitInput): CanonicalEvent;
}
