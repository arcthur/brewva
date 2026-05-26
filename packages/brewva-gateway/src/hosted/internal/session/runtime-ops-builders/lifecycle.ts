import { createFourPortLifecycleRuntimeOps } from "@brewva/brewva-tools/runtime-port";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildLifecycleRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["lifecycle"] {
  return createFourPortLifecycleRuntimeOps(ctx);
}
