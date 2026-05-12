import type {
  RuntimeGovernanceServices,
  RuntimeServiceRegistrarOptions,
} from "../../runtime/service-registrar-types.js";
import { conventionsSurfaceContribution } from "./runtime-surface.js";
import { ConventionAdmissionService } from "./service.js";

export interface RuntimeConventionsDomainRegistration {
  services: Pick<RuntimeGovernanceServices, "getConventionAdmissionService">;
  surfaceContribution: typeof conventionsSurfaceContribution;
}

export function registerConventionsDomain(
  options: RuntimeServiceRegistrarOptions,
  governanceServices: Pick<RuntimeGovernanceServices, "reversibleMutationService">,
): RuntimeConventionsDomainRegistration {
  let conventionAdmissionService: ConventionAdmissionService | undefined;
  const getConventionAdmissionService = (): ConventionAdmissionService => {
    conventionAdmissionService ??= new ConventionAdmissionService({
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      listEvents: (sessionId) => options.coreDependencies.eventStore.list(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      reversibleMutationService: governanceServices.reversibleMutationService,
    });
    return conventionAdmissionService;
  };
  return {
    services: {
      getConventionAdmissionService,
    },
    surfaceContribution: conventionsSurfaceContribution,
  };
}
