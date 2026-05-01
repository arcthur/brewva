import type { ReasoningRevertRecord } from "./types.js";

export function buildReasoningRevertSummaryDetails(
  revert: Pick<
    ReasoningRevertRecord,
    "continuityPacket" | "revertId" | "toCheckpointId" | "trigger" | "linkedRollbackReceiptIds"
  >,
): Record<string, unknown> {
  return {
    schema: revert.continuityPacket.schema,
    revertId: revert.revertId,
    toCheckpointId: revert.toCheckpointId,
    trigger: revert.trigger,
    linkedRollbackReceiptIds: [...revert.linkedRollbackReceiptIds],
  };
}
