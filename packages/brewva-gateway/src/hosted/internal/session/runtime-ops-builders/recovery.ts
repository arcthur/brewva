import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildRecoveryRuntimeOps(
  _ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["recovery"] {
  return {
    getPosture: () => undefined,
    getWorkingSet: () => undefined,
    listPending: () => [],
  };
}
