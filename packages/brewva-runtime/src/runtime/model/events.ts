import type { EventId, RuntimeRecoveryCause, SessionId } from "../runtime-api.js";

export interface CheckpointCommittedPayload {
  readonly sessionId: SessionId;
  readonly summary: string;
  readonly sourceEventIds: readonly EventId[];
  readonly eventCount: number;
  readonly cause: Extract<RuntimeRecoveryCause, "compaction_required">;
}
