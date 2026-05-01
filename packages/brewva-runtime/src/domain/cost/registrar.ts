import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import type { LedgerService } from "../ledger/api.js";
import type { SkillLifecycleService } from "../skills/api.js";
import { CostService } from "./cost.js";
import { costSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeCostDomainRegistration {
  services: {
    costService: CostService;
  };
  surfaceContribution: typeof costSurfaceContribution;
}

export function registerCostDomain(
  options: RuntimeServiceRegistrarOptions,
  support: {
    ledgerService: LedgerService;
    skillLifecycleService: SkillLifecycleService;
  },
): RuntimeCostDomainRegistration {
  return {
    services: {
      costService: new CostService({
        costTracker: options.coreDependencies.costTracker,
        getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
        ledgerService: support.ledgerService,
        skillLifecycleService: support.skillLifecycleService,
        governancePort: options.governancePort,
      }),
    },
    surfaceContribution: costSurfaceContribution,
  };
}
