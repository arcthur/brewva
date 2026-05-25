import type {
  ActiveReasoningBranchState,
  ReasoningCheckpointRecord,
  ReasoningRevertRecord,
} from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildReasoningRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["reasoning"] {
  return {
    checkpoints: {
      get: () => undefined,
      list: () => [],
      record(sessionId, input) {
        const record = makeReasoningCheckpointRecord(input);
        ctx.emit(sessionId, "reasoning_checkpoint_recorded", record);
        return record;
      },
    },
    reverts: {
      canRevertTo: () => false,
      list: () => [],
      revert(sessionId, input) {
        const record = makeReasoningRevertRecord(input);
        ctx.emit(sessionId, "reasoning_revert_recorded", record);
        return record;
      },
    },
    state: {
      getActive: (): ActiveReasoningBranchState => ({
        activeBranchId: "main",
        activeCheckpointId: null,
        activeLineageCheckpointIds: [],
        checkpoints: [],
        reverts: [],
      }),
    },
  };
}

function makeReasoningCheckpointRecord(input: Record<string, unknown>): ReasoningCheckpointRecord {
  return {
    checkpointId:
      typeof input.checkpointId === "string" ? input.checkpointId : `checkpoint-${Date.now()}`,
    branchId: typeof input.branchId === "string" ? input.branchId : "main",
    boundary: typeof input.boundary === "string" ? input.boundary : "manual",
    leafEntryId: typeof input.leafEntryId === "string" ? input.leafEntryId : null,
  };
}

function makeReasoningRevertRecord(input: Record<string, unknown>): ReasoningRevertRecord {
  return {
    revertId: typeof input.revertId === "string" ? input.revertId : `revert-${Date.now()}`,
    toCheckpointId: typeof input.toCheckpointId === "string" ? input.toCheckpointId : "unknown",
    fromCheckpointId: typeof input.fromCheckpointId === "string" ? input.fromCheckpointId : null,
    trigger: typeof input.trigger === "string" ? input.trigger : "manual",
    newBranchId: typeof input.newBranchId === "string" ? input.newBranchId : `branch-${Date.now()}`,
  };
}
