import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import type { TaskService } from "../task/api.js";
import { createContextService, type ContextService } from "./context.js";

export interface RuntimeContextDomainRegistration {
  services: {
    contextService: ContextService;
  };
}

export function registerContextDomain(
  options: RuntimeServiceRegistrarOptions,
  _support: {
    taskService: TaskService;
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
        governancePort: options.governancePort,
      }),
    },
  };
}
