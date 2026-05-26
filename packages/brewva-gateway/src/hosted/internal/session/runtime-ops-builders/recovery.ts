import { createFourPortRecoveryRuntimeOps } from "@brewva/brewva-tools/runtime-port";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildRecoveryRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["recovery"] {
  return createFourPortRecoveryRuntimeOps(ctx);
}
