import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { LedgerService } from "./ledger.js";

export interface LedgerSurfaceDependencies {
  getLedgerService(): LedgerService;
}

export function createLedgerSurfaceMethods(deps: LedgerSurfaceDependencies) {
  return {
    getDigest: (sessionId: string) => deps.getLedgerService().getLedgerDigest(sessionId),
    query: (sessionId: string, query: Parameters<LedgerService["queryLedger"]>[1]) =>
      deps.getLedgerService().queryLedger(sessionId, query),
    listRows: (sessionId?: Parameters<LedgerService["listLedgerRows"]>[0]) =>
      deps.getLedgerService().listLedgerRows(sessionId),
    verifyIntegrity: (sessionId: string) =>
      deps.getLedgerService().verifyLedgerIntegrity(sessionId),
    getPath: () => deps.getLedgerService().getLedgerPath(),
  };
}

export type RuntimeLedgerSurfaceMethods = ReturnType<typeof createLedgerSurfaceMethods>;

export const ledgerSurfaceContribution = {
  inspect: ["getDigest", "query", "listRows", "verifyIntegrity", "getPath"],
} as const satisfies SurfaceContribution<RuntimeLedgerSurfaceMethods>;

export const ledgerRuntimeSurface = defineRuntimeSurfaceModule({
  name: "ledger",
  createMethods: createLedgerSurfaceMethods,
  contribution: ledgerSurfaceContribution,
});
