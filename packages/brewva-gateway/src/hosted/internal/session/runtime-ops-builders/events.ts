import { createFourPortEventsRuntimeOps } from "@brewva/brewva-tools/runtime-port";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildEventsRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["events"] {
  return createFourPortEventsRuntimeOps(ctx);
}
