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
      // Honest vacuous result: the hosted adapter keeps no ledger store (getDigest/listRows
      // are empty above), so there is nothing to corrupt — but say so via `reason` rather than
      // claiming a passed integrity check, so an operator never mistakes this for a real
      // verification of an on-disk ledger.
      verifyIntegrity: () => ({
        ok: true,
        valid: true,
        reason: "hosted_adapter_has_no_ledger_store",
      }),
    },
  };
}
