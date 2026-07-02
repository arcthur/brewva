import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  APPROVAL_DECIDED_EVENT_TYPE,
  APPROVAL_REQUESTED_EVENT_TYPE,
  CLAIM_UPSERTED_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import { RECOVERY_WAL_APPENDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import {
  ROLLBACK_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import type { RecallEvidenceStrength, RecallTrustLabel } from "../types.js";

export const RECALL_KERNEL_CLAIM_TAPE_EVENT_TYPES = [CLAIM_UPSERTED_EVENT_TYPE] as const;

export const RECALL_STRONG_TAPE_EVENT_TYPES = [
  CLAIM_UPSERTED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
  APPROVAL_REQUESTED_EVENT_TYPE,
  APPROVAL_DECIDED_EVENT_TYPE,
  RECOVERY_WAL_APPENDED_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
] as const;

const RECALL_KERNEL_CLAIM_TAPE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  RECALL_KERNEL_CLAIM_TAPE_EVENT_TYPES,
);

const RECALL_STRONG_TAPE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  RECALL_STRONG_TAPE_EVENT_TYPES,
);

export function isKernelClaimRecallTapeEvent(event: Pick<BrewvaEventRecord, "type">): boolean {
  return RECALL_KERNEL_CLAIM_TAPE_EVENT_TYPE_SET.has(event.type);
}

export function isStrongRecallTapeEvent(event: Pick<BrewvaEventRecord, "type">): boolean {
  return RECALL_STRONG_TAPE_EVENT_TYPE_SET.has(event.type);
}

export function classifyRecallTapeEvent(
  event: BrewvaEventRecord,
  currentSessionId: string,
): {
  trustLabel: RecallTrustLabel;
  evidenceStrength: RecallEvidenceStrength;
} {
  if (isKernelClaimRecallTapeEvent(event)) {
    return {
      trustLabel: "Kernel claim",
      evidenceStrength: "strong",
    };
  }
  if (isStrongRecallTapeEvent(event)) {
    return {
      trustLabel: "Verified evidence",
      evidenceStrength: "strong",
    };
  }
  if (event.sessionId === currentSessionId) {
    return {
      trustLabel: "Session-local memory",
      evidenceStrength: "weak",
    };
  }
  return {
    trustLabel: "Advisory posture",
    evidenceStrength: "weak",
  };
}
