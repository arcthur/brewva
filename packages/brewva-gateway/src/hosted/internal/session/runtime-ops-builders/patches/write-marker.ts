import { VERIFICATION_WRITE_MARKED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../../runtime-ops-context.js";

/**
 * A successfully applied source patch is the strongest durable write receipt;
 * mark it for verification hygiene (write-after-verify detection). The marker
 * had no producer after the four-port cutover deleted the patching domain
 * (contract-liveness audit, 2026-07-02).
 */
export function recordAppliedPatchWriteMarker(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  payload: object | null | undefined,
): void {
  const record = ctx.readObjectPayload(payload);
  if (record.ok !== true) {
    return;
  }
  ctx.emit(sessionId, VERIFICATION_WRITE_MARKED_EVENT_TYPE, {
    planId: typeof record.planId === "string" ? record.planId : null,
    patchSetId: typeof record.patchSetId === "string" ? record.patchSetId : null,
    paths: (Array.isArray(record.appliedPaths) ? record.appliedPaths : []).filter(
      (path): path is string => typeof path === "string",
    ),
  });
}
