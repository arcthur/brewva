import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import { WorkbenchService } from "./service.js";

export interface RuntimeWorkbenchDomainRegistration {
  services: {
    workbenchService: WorkbenchService;
  };
}

export function registerWorkbenchDomain(
  options: RuntimeServiceRegistrarOptions,
): RuntimeWorkbenchDomainRegistration {
  return {
    services: {
      workbenchService: new WorkbenchService({
        getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
      }),
    },
  };
}
