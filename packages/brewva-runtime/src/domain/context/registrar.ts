import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import type { LedgerService } from "../ledger/api.js";
import type { TaskService } from "../task/api.js";
import type { WorkbenchService } from "../workbench/api.js";
import { createContextService, type ContextService } from "./context.js";

export interface RuntimeContextDomainRegistration {
  services: {
    contextService: ContextService;
  };
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
        workspaceRoot: options.kernel.workspaceRoot,
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
  };
}
