import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import type { EffectCommitmentDeskService } from "../proposals/api.js";
import { LedgerService } from "./ledger.js";
import { ledgerSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeLedgerDomainRegistration {
  services: {
    ledgerService: LedgerService;
  };
  surfaceContribution: typeof ledgerSurfaceContribution;
}

export function registerLedgerDomain(
  options: RuntimeServiceRegistrarOptions,
  support: {
    getEffectCommitmentDeskService(): EffectCommitmentDeskService;
  },
): RuntimeLedgerDomainRegistration {
  return {
    services: {
      ledgerService: new LedgerService({
        config: options.config,
        evidenceLedger: options.coreDependencies.evidenceLedger,
        sessionState: options.sessionState,
        getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
        effectCommitmentDeskService: {
          observeToolOutcome: (input) =>
            support.getEffectCommitmentDeskService().observeToolOutcome(input),
        },
      }),
    },
    surfaceContribution: ledgerSurfaceContribution,
  };
}
