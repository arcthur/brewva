import type { SessionOpenQuestion } from "@brewva/brewva-gateway";
import type { DelegationRunRecord } from "@brewva/brewva-runtime/protocol";
import type { BrewvaReplaySession } from "@brewva/brewva-runtime/protocol";
import type { PendingEffectCommitmentRequest } from "@brewva/brewva-runtime/protocol";

export interface OperatorSurfaceSnapshot {
  approvals: PendingEffectCommitmentRequest[];
  questions: SessionOpenQuestion[];
  taskRuns: DelegationRunRecord[];
  sessions: BrewvaReplaySession[];
}
