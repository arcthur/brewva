import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import type { EffectCommitmentDeskService } from "../proposals/api.js";
import { LedgerService } from "./ledger.js";

export interface RuntimeLedgerDomainRegistration {
  services: {
    ledgerService: LedgerService;
  };
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
  };
}
