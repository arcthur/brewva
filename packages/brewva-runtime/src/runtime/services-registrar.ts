import { registerRuntimeContextServices } from "./context-service-registrar.js";
import { registerRuntimeGovernanceServices } from "./governance-service-registrar.js";
import { registerRuntimeLazyDomainServices } from "./lazy-service-registrar.js";
import type {
  RuntimeLazyServiceFactories,
  RuntimeLazyServiceRegistrarOptions,
  RuntimeServiceDependencies,
  RuntimeServiceRegistrarOptions,
} from "./service-registrar-types.js";
import { registerRuntimeSessionServices } from "./session-service-registrar.js";
import { registerRuntimeWorkServices } from "./work-service-registrar.js";

export type {
  RuntimeLazyServiceFactories,
  RuntimeLazyServiceRegistrarOptions,
  RuntimeServiceDependencies,
  RuntimeServiceRegistrarOptions,
} from "./service-registrar-types.js";

export function registerRuntimeServiceDependencies(
  options: RuntimeServiceRegistrarOptions,
): RuntimeServiceDependencies {
  const governanceServices = registerRuntimeGovernanceServices(options);
  const workServices = registerRuntimeWorkServices(options, governanceServices);
  const contextServices = registerRuntimeContextServices(options, workServices);
  const sessionServices = registerRuntimeSessionServices(
    options,
    workServices,
    contextServices,
    governanceServices,
  );

  return {
    skillLifecycleService: workServices.skillLifecycleService,
    taskService: workServices.taskService,
    truthService: workServices.truthService,
    ledgerService: workServices.ledgerService,
    costService: workServices.costService,
    contextService: contextServices.contextService,
    taskWatchdogService: workServices.taskWatchdogService,
    eventPipeline: sessionServices.eventPipeline,
    toolLifecycleRecoveryWalService: sessionServices.toolLifecycleRecoveryWalService,
    sessionLifecycleService: sessionServices.sessionLifecycleService,
    reversibleMutationService: governanceServices.reversibleMutationService,
    getTapeService: () => sessionServices.getTapeService(),
    getEffectCommitmentDeskService: () => governanceServices.getEffectCommitmentDeskService(),
    getProposalAdmissionService: () => governanceServices.getProposalAdmissionService(),
    clearEffectCommitmentDeskState: (sessionId: string) =>
      governanceServices.clearEffectCommitmentDeskState(sessionId),
  };
}

export function registerRuntimeLazyServiceFactories(
  options: RuntimeLazyServiceRegistrarOptions,
): RuntimeLazyServiceFactories {
  return registerRuntimeLazyDomainServices(options);
}
