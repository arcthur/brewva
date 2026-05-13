import type { RuntimeLazyServiceRegistrarOptions } from "../../runtime/wiring.js";
import { MutationRollbackService } from "../governance/api.js";
import type { ReversibleMutationService } from "../governance/api.js";
import type { LedgerService } from "../ledger/api.js";
import { FileChangeService } from "./file-change.js";

export interface RuntimePatchingDomainRegistration {
  lazyFactories: {
    createFileChangeService(): FileChangeService;
    createMutationRollbackService(): MutationRollbackService;
  };
}

export function registerPatchingDomain(
  options: RuntimeLazyServiceRegistrarOptions,
  support: {
    ledgerService: LedgerService;
    reversibleMutationService: ReversibleMutationService;
  },
): RuntimePatchingDomainRegistration {
  let fileChangeService: FileChangeService | undefined;
  const getFileChangeService = (): FileChangeService => {
    fileChangeService ??= new FileChangeService({
      sessionState: options.sessionState,
      fileChanges: options.coreDependencies.fileChanges,
      costTracker: options.coreDependencies.costTracker,
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      ledgerService: support.ledgerService,
      reversibleMutationService: support.reversibleMutationService,
    });
    return fileChangeService;
  };

  let mutationRollbackService: MutationRollbackService | undefined;
  return {
    lazyFactories: {
      createFileChangeService: () => getFileChangeService(),
      createMutationRollbackService: () => {
        mutationRollbackService ??= new MutationRollbackService({
          getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
          recordEvent: (input) => options.kernel.recordEvent(input),
          reversibleMutationService: support.reversibleMutationService,
          fileChangeService: getFileChangeService(),
        });
        return mutationRollbackService;
      },
    },
  };
}
