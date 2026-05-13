import type { RuntimeLazyServiceRegistrarOptions } from "../../runtime/wiring.js";
import { VERIFICATION_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { VerificationService } from "./verification.js";

export interface RuntimeVerificationDomainRegistration {
  lazyFactories: {
    createVerificationService(): VerificationService;
  };
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
          ledgerService: options.ledgerService,
        }),
    },
    eventDescriptors: VERIFICATION_EVENT_DESCRIPTORS,
  };
}
