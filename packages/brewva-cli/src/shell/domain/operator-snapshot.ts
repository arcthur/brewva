import type { SessionOpenQuestion } from "@brewva/brewva-gateway";
import type { DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import type { PendingEffectCommitmentRequest } from "@brewva/brewva-vocabulary/iteration";
import type { BrewvaReplaySession } from "@brewva/brewva-vocabulary/session";

export interface OperatorSurfaceSnapshot {
  approvals: PendingEffectCommitmentRequest[];
  questions: SessionOpenQuestion[];
  taskRuns: DelegationRunRecord[];
  sessions: BrewvaReplaySession[];
}
