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

export interface TapeCommitPort {
  commit(event: CanonicalEventCommitInput): CanonicalEvent;
}
