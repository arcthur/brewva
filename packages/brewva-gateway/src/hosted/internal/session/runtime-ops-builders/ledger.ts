import type { TapeLedgerRow } from "@brewva/brewva-vocabulary/session";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildLedgerRuntimeOps(
  _ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["ledger"] {
  return {
    store: {
      getDigest: () => undefined,
      getPath: () => "",
      listRows: (): TapeLedgerRow[] => [],
      query: () => "",
      verifyIntegrity: () => ({ ok: true, valid: true }),
    },
  };
}
