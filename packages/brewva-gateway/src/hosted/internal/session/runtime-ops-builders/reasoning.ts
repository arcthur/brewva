import { isRecord } from "@brewva/brewva-std/unknown";
import {
  RUNTIME_OPS_REASONING_CHECKPOINT_RECORDED_KIND,
  RUNTIME_OPS_REASONING_REVERT_RECORDED_KIND,
} from "@brewva/brewva-vocabulary/events";
import type {
  ActiveReasoningBranchState,
  ReasoningCheckpointRecord,
  ReasoningRevertRecord,
} from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

// Pure, no-cache projections over the durable reasoning-checkpoint/revert events
// (RFC WS3): every read replays the tape, mirroring the hosted-state projector
// pattern. record()/revert() stay emit-only; the query side derives from tape.

function projectCheckpoints(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): ReasoningCheckpointRecord[] {
  const records: ReasoningCheckpointRecord[] = [];
  for (const event of ctx.listEvents(sessionId, {
    type: RUNTIME_OPS_REASONING_CHECKPOINT_RECORDED_KIND,
  })) {
    const payload = event.payload;
    if (
      isRecord(payload) &&
      typeof payload.checkpointId === "string" &&
      typeof payload.branchId === "string" &&
      typeof payload.boundary === "string"
    ) {
      records.push({
        checkpointId: payload.checkpointId,
        branchId: payload.branchId,
        boundary: payload.boundary,
        leafEntryId: typeof payload.leafEntryId === "string" ? payload.leafEntryId : null,
      });
    }
  }
  return records;
}

function projectReverts(ctx: HostedRuntimeOpsContext, sessionId: string): ReasoningRevertRecord[] {
  const records: ReasoningRevertRecord[] = [];
  for (const event of ctx.listEvents(sessionId, {
    type: RUNTIME_OPS_REASONING_REVERT_RECORDED_KIND,
  })) {
    const payload = event.payload;
    if (
      isRecord(payload) &&
      typeof payload.revertId === "string" &&
      typeof payload.toCheckpointId === "string" &&
      typeof payload.trigger === "string" &&
      typeof payload.newBranchId === "string"
    ) {
      records.push({
        revertId: payload.revertId,
        toCheckpointId: payload.toCheckpointId,
        fromCheckpointId:
          typeof payload.fromCheckpointId === "string" ? payload.fromCheckpointId : null,
        trigger: payload.trigger,
        newBranchId: payload.newBranchId,
      });
    }
  }
  return records;
}

function projectActiveBranch(
  checkpoints: readonly ReasoningCheckpointRecord[],
  reverts: readonly ReasoningRevertRecord[],
): ActiveReasoningBranchState {
  // The latest revert re-anchors the active branch to its new branch and target
  // checkpoint; with no reverts the active branch is the original "main".
  const lastRevert = reverts.at(-1);
  const activeBranchId = lastRevert?.newBranchId ?? "main";
  const activeCheckpointId = lastRevert?.toCheckpointId ?? checkpoints.at(-1)?.checkpointId ?? null;
  const activeLineageCheckpointIds = checkpoints
    .filter((checkpoint) => checkpoint.branchId === activeBranchId)
    .map((checkpoint) => checkpoint.checkpointId);
  return { activeBranchId, activeCheckpointId, activeLineageCheckpointIds, checkpoints, reverts };
}

export function buildReasoningRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["reasoning"] {
  return {
    checkpoints: {
      get: (sessionId, checkpointId) =>
        projectCheckpoints(ctx, sessionId).find(
          (checkpoint) => checkpoint.checkpointId === checkpointId,
        ),
      list: (sessionId) => projectCheckpoints(ctx, sessionId),
      record(sessionId, input) {
        const record = makeReasoningCheckpointRecord(input);
        ctx.emit(sessionId, RUNTIME_OPS_REASONING_CHECKPOINT_RECORDED_KIND, record);
        return record;
      },
    },
    reverts: {
      canRevertTo: (sessionId, checkpointId) =>
        projectCheckpoints(ctx, sessionId).some(
          (checkpoint) => checkpoint.checkpointId === checkpointId,
        ),
      list: (sessionId) => projectReverts(ctx, sessionId),
      revert(sessionId, input) {
        const record = makeReasoningRevertRecord(input);
        ctx.emit(sessionId, RUNTIME_OPS_REASONING_REVERT_RECORDED_KIND, record);
        return record;
      },
    },
    state: {
      getActive: (sessionId) =>
        projectActiveBranch(projectCheckpoints(ctx, sessionId), projectReverts(ctx, sessionId)),
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
