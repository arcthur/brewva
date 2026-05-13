import type { EventPipelineService } from "../sessions/api.js";
import { ToolLifecycleRecoveryWalService } from "./tool-lifecycle-recovery-wal.js";

export interface RuntimeRecoveryDomainRegistration {
  services: {
    toolLifecycleRecoveryWalService: ToolLifecycleRecoveryWalService;
  };
}

export function registerRecoveryDomain(
  options: {
    recoveryWalStore: ConstructorParameters<
      typeof ToolLifecycleRecoveryWalService
    >[0]["recoveryWalStore"];
  },
  support: {
    eventPipeline: Pick<EventPipelineService, "subscribeEvents">;
  },
): RuntimeRecoveryDomainRegistration {
  return {
    services: {
      toolLifecycleRecoveryWalService: new ToolLifecycleRecoveryWalService({
        recoveryWalStore: options.recoveryWalStore,
        eventPipeline: support.eventPipeline,
      }),
    },
  };
}
