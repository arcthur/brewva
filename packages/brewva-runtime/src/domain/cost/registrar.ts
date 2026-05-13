import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import type { LedgerService } from "../ledger/api.js";
import { CostService } from "./cost.js";

export interface RuntimeCostDomainRegistration {
  services: {
    costService: CostService;
  };
}

export function registerCostDomain(
  options: RuntimeServiceRegistrarOptions,
  support: {
    ledgerService: LedgerService;
  },
): RuntimeCostDomainRegistration {
  return {
    services: {
      costService: new CostService({
        costTracker: options.coreDependencies.costTracker,
        getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
        ledgerService: support.ledgerService,
        governancePort: options.governancePort,
      }),
    },
  };
}
