import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { workbenchSurfaceContribution } from "./runtime-surface.js";
import { WorkbenchService } from "./service.js";

export interface RuntimeWorkbenchDomainRegistration {
  services: {
    workbenchService: WorkbenchService;
  };
  surfaceContribution: typeof workbenchSurfaceContribution;
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
    surfaceContribution: workbenchSurfaceContribution,
  };
}
