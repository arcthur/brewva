import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildVerificationRuntimeOps(
  _ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["verification"] {
  return {
    checks: {
      evaluate: () => ({ ok: true }),
      verify: () => ({ ok: true }),
    },
  };
}
