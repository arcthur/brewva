import { registerCredentialsDomain } from "../domain/credentials/api.js";
import { registerParallelDomain } from "../domain/parallel/api.js";
import { registerPatchingDomain } from "../domain/patching/api.js";
import { registerReasoningDomain } from "../domain/reasoning/api.js";
import { registerScheduleDomain } from "../domain/schedule/api.js";
import { registerSessionsLazyDomain } from "../domain/sessions/api.js";
import { registerToolsDomain } from "../domain/tools/api.js";
import { registerVerificationDomain } from "../domain/verification/api.js";
import type {
  RuntimeLazyServiceFactories,
  RuntimeLazyServiceRegistrarOptions,
} from "./service-registrar-types.js";

export function registerRuntimeLazyDomainServices(
  options: RuntimeLazyServiceRegistrarOptions,
): RuntimeLazyServiceFactories {
  const patchingDomain = registerPatchingDomain(options, {
    ledgerService: options.ledgerService,
    skillLifecycleService: options.skillLifecycleService,
    reversibleMutationService: options.reversibleMutationService,
  });
  const reasoningDomain = registerReasoningDomain(options);
  const sessionsDomain = registerSessionsLazyDomain(options, {
    getReasoningService: () => reasoningDomain.lazyFactories.createReasoningService(),
    getFileChangeService: () => patchingDomain.lazyFactories.createFileChangeService(),
  });
  const parallelDomain = registerParallelDomain(options, {
    getFileChangeService: () => patchingDomain.lazyFactories.createFileChangeService(),
  });
  const credentialsDomain = registerCredentialsDomain(options);
  const scheduleDomain = registerScheduleDomain(options);
  const verificationDomain = registerVerificationDomain(options);

  const toolsDomain = registerToolsDomain(options, {
    getFileChangeService: () => patchingDomain.lazyFactories.createFileChangeService(),
    getResourceLeaseService: () => parallelDomain.lazyFactories.createResourceLeaseService(),
  });

  return {
    createCredentialVaultService: () =>
      credentialsDomain.lazyFactories.createCredentialVaultService(),
    createSessionRewindService: () => sessionsDomain.lazyFactories.createSessionRewindService(),
    createFileChangeService: () => patchingDomain.lazyFactories.createFileChangeService(),
    createMutationRollbackService: () =>
      patchingDomain.lazyFactories.createMutationRollbackService(),
    createParallelService: () => parallelDomain.lazyFactories.createParallelService(),
    createReasoningService: () => reasoningDomain.lazyFactories.createReasoningService(),
    createResourceLeaseService: () => parallelDomain.lazyFactories.createResourceLeaseService(),
    createScheduleIntentService: () => scheduleDomain.lazyFactories.createScheduleIntentService(),
    createSessionWireService: () => sessionsDomain.lazyFactories.createSessionWireService(),
    ...toolsDomain.lazyFactories,
    createVerificationService: () => verificationDomain.lazyFactories.createVerificationService(),
  };
}
