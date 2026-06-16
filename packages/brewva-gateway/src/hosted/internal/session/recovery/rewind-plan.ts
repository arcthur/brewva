import type { SessionRewindMode } from "@brewva/brewva-vocabulary/session";

// Step 1 of the one recovery transaction owner (RFC WS3): derive a
// side-effect-free plan before any mutation. The plan also fixes the cost class,
// so the common path stays cheap (RFC "One owner does not mean one cost"):
//
//   - conversation-only rewind is a `fork`: it moves the active reasoning lineage
//     append-only and reverses nothing, so it needs no WAL prepare and no
//     compensation.
//   - code / both rewind is a `transaction`: it mutates tracked files, so it
//     rolls patch sets back in reverse order and must be compensatable.
//
// The plan is pure data; the executor (a later WS3 step) is the only thing that
// touches the world, and only through existing receipt-bearing capabilities.

export type RewindCostClass = "fork" | "transaction";

export interface RewindPlan {
  readonly mode: SessionRewindMode;
  readonly costClass: RewindCostClass;
  readonly checkpointId: string;
  /** Patch sets to roll back, in reverse commit order. Empty for a fork. */
  readonly rollbackPatchSetIds: readonly string[];
  /** Whether the active reasoning lineage moves to the checkpoint's leaf. */
  readonly movesLineage: boolean;
  /** Whether a failed apply must compensate (only when workspace effects roll back). */
  readonly requiresCompensation: boolean;
}

export function deriveRewindPlan(input: {
  readonly mode: SessionRewindMode;
  readonly checkpointId: string;
  /** Active-lineage patch sets committed after the target checkpoint, in commit order. */
  readonly patchSetIdsAfterCheckpoint: readonly string[];
}): RewindPlan {
  const touchesWorkspace = input.mode === "code" || input.mode === "both";
  const touchesConversation = input.mode === "conversation" || input.mode === "both";
  const rollbackPatchSetIds = touchesWorkspace ? input.patchSetIdsAfterCheckpoint.toReversed() : [];

  return {
    mode: input.mode,
    costClass: touchesWorkspace ? "transaction" : "fork",
    checkpointId: input.checkpointId,
    rollbackPatchSetIds,
    movesLineage: touchesConversation,
    requiresCompensation: touchesWorkspace && rollbackPatchSetIds.length > 0,
  };
}
