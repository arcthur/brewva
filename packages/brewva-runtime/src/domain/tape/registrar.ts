import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { tapeSurfaceContribution } from "./runtime-surface.js";
import { TapeService } from "./service.js";

export interface RuntimeTapeDomainRegistration {
  services: {
    getTapeService(): TapeService;
  };
  surfaceContribution: typeof tapeSurfaceContribution;
}

export function registerTapeDomain(
  options: RuntimeServiceRegistrarOptions,
): RuntimeTapeDomainRegistration {
  let tapeService: TapeService | undefined;
  return {
    services: {
      getTapeService: () => {
        tapeService ??= new TapeService({
          tapeConfig: options.config.tape,
          sessionState: options.sessionState,
          queryEvents: (sessionId, query) =>
            options.coreDependencies.eventStore.list(sessionId, query),
          getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
          getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
          getClaimState: (sessionId) => options.kernel.getClaimState(sessionId),
          getCostSummary: (sessionId) => options.resolveCheckpointCostSummary(sessionId),
          getCostSkillLastTurnByName: (sessionId) =>
            options.resolveCheckpointCostSkillLastTurnByName(sessionId),
          getCheckpointEvidenceState: (sessionId) =>
            options.coreDependencies.turnReplay.getCheckpointEvidenceState(sessionId),
          getCheckpointProjectionState: (sessionId) =>
            options.coreDependencies.turnReplay.getCheckpointProjectionState(sessionId),
          recordEvent: (input) => options.kernel.recordEvent(input),
        });
        return tapeService;
      },
    },
    surfaceContribution: tapeSurfaceContribution,
  };
}
