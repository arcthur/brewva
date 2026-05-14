import type { SessionOpenQuestion } from "@brewva/brewva-gateway";
import type { DelegationRunRecord } from "@brewva/brewva-runtime/delegation";
import type { BrewvaReplaySession } from "@brewva/brewva-runtime/events";
import type { PendingEffectCommitmentRequest } from "@brewva/brewva-runtime/proposals";

export interface OperatorSurfaceSnapshot {
  approvals: PendingEffectCommitmentRequest[];
  questions: SessionOpenQuestion[];
  taskRuns: DelegationRunRecord[];
  sessions: BrewvaReplaySession[];
}
