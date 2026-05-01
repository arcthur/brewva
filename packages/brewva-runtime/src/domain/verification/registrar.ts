import type { RuntimeLazyServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { VERIFICATION_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { verificationSurfaceContribution } from "./runtime-surface.js";
import { VerificationService } from "./verification.js";

export interface RuntimeVerificationDomainRegistration {
  lazyFactories: {
    createVerificationService(): VerificationService;
  };
  surfaceContribution: typeof verificationSurfaceContribution;
  eventDescriptors: typeof VERIFICATION_EVENT_DESCRIPTORS;
}

export function registerVerificationDomain(
  options: RuntimeLazyServiceRegistrarOptions,
): RuntimeVerificationDomainRegistration {
  return {
    lazyFactories: {
      createVerificationService: () =>
        new VerificationService({
          cwd: options.cwd,
          config: options.config,
          verificationGate: options.coreDependencies.verificationGate,
          getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
          recordEvent: (input) => options.kernel.recordEvent(input),
          governancePort: options.governancePort,
          skillLifecycleService: options.skillLifecycleService,
          ledgerService: options.ledgerService,
        }),
    },
    surfaceContribution: verificationSurfaceContribution,
    eventDescriptors: VERIFICATION_EVENT_DESCRIPTORS,
  };
}
