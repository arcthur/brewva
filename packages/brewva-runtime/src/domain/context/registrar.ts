import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import type { LedgerService } from "../ledger/api.js";
import type { TaskService } from "../task/api.js";
import type { WorkbenchService } from "../workbench/api.js";
import { createContextService, type ContextService } from "./context.js";
import { contextSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeContextDomainRegistration {
  services: {
    contextService: ContextService;
  };
  surfaceContribution: typeof contextSurfaceContribution;
}

export function registerContextDomain(
  options: RuntimeServiceRegistrarOptions,
  support: {
    taskService: TaskService;
    ledgerService: LedgerService;
    workbenchService?: WorkbenchService;
  },
): RuntimeContextDomainRegistration {
  return {
    services: {
      contextService: createContextService({
        config: options.config,
        contextBudget: options.coreDependencies.contextBudget,
        sessionState: options.sessionState,
        getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
        ledgerService: support.ledgerService,
        workbenchService: support.workbenchService,
        governancePort: options.governancePort,
      }),
    },
    surfaceContribution: contextSurfaceContribution,
  };
}
