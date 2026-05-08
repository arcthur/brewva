import type { RuntimeLazyServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import type { FileChangeService } from "../patching/api.js";
import { ParallelService } from "./parallel.js";
import { ResourceLeaseService } from "./resource-lease.js";

export interface RuntimeParallelDomainRegistration {
  lazyFactories: {
    createParallelService(): ParallelService;
    createResourceLeaseService(): ResourceLeaseService;
  };
}

export function registerParallelDomain(
  options: RuntimeLazyServiceRegistrarOptions,
  support: {
    getFileChangeService(): FileChangeService;
  },
): RuntimeParallelDomainRegistration {
  let resourceLeaseService: ResourceLeaseService | undefined;
  const getResourceLeaseService = (): ResourceLeaseService => {
    resourceLeaseService ??= new ResourceLeaseService({
      sessionState: options.sessionState,
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
    });
    return resourceLeaseService;
  };

  let parallelService: ParallelService | undefined;
  return {
    lazyFactories: {
      createParallelService: () => {
        parallelService ??= new ParallelService({
          workspaceRoot: options.workspaceRoot,
          parallel: options.coreDependencies.parallel,
          parallelResults: options.coreDependencies.parallelResults,
          sessionState: options.sessionState,
          eventStore: options.coreDependencies.eventStore,
          subscribeEvents: (listener) => options.eventPipeline.subscribeEvents(listener),
          getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
          recordEvent: (input) => options.kernel.recordEvent(input),
          fileChangeService: support.getFileChangeService(),
        });
        return parallelService;
      },
      createResourceLeaseService: () => getResourceLeaseService(),
    },
  };
}
