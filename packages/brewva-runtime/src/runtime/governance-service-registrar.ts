import { registerConventionsDomain } from "../domain/conventions/api.js";
import { registerGovernanceDomain } from "../domain/governance/api.js";
import { registerProposalsDomain } from "../domain/proposals/api.js";
import type {
  RuntimeGovernanceServices,
  RuntimeServiceRegistrarOptions,
} from "./service-registrar-types.js";

export function registerRuntimeGovernanceServices(
  options: RuntimeServiceRegistrarOptions,
): RuntimeGovernanceServices {
  const governanceDomain = registerGovernanceDomain(options);
  const proposalsDomain = registerProposalsDomain(options);
  const conventionsDomain = registerConventionsDomain(options, governanceDomain.services);

  return {
    reversibleMutationService: governanceDomain.services.reversibleMutationService,
    ...proposalsDomain.services,
    ...conventionsDomain.services,
  };
}
