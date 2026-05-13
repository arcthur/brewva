import type { LedgerService } from "./ledger.js";

export interface LedgerSurfaceDependencies {
  getLedgerService(): LedgerService;
}

export function createLedgerSurfaceMethods(deps: LedgerSurfaceDependencies) {
  return {
    store: {
      getDigest: (sessionId: string) => deps.getLedgerService().getLedgerDigest(sessionId),
      query: (sessionId: string, query: Parameters<LedgerService["queryLedger"]>[1]) =>
        deps.getLedgerService().queryLedger(sessionId, query),
      listRows: (sessionId?: Parameters<LedgerService["listLedgerRows"]>[0]) =>
        deps.getLedgerService().listLedgerRows(sessionId),
      verifyIntegrity: (sessionId: string) =>
        deps.getLedgerService().verifyLedgerIntegrity(sessionId),
      getPath: () => deps.getLedgerService().getLedgerPath(),
    },
  };
}

export type RuntimeLedgerSurfaceMethods = ReturnType<typeof createLedgerSurfaceMethods>;

export function createLedgerInspectSurface(deps: LedgerSurfaceDependencies) {
  return createLedgerSurfaceMethods(deps);
}
