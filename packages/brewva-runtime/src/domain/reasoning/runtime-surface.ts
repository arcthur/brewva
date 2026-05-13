import type { ReasoningService } from "./reasoning.js";
import type { ReasoningRevertInput, RecordReasoningCheckpointInput } from "./types.js";

export interface ReasoningSurfaceDependencies {
  getReasoningService(): ReasoningService;
}

export function createReasoningSurfaceMethods(deps: ReasoningSurfaceDependencies) {
  return {
    authority: {
      checkpoints: {
        record: (sessionId: string, input: RecordReasoningCheckpointInput) =>
          deps.getReasoningService().recordCheckpoint(sessionId, input),
      },
      reverts: {
        revert: (sessionId: string, input: ReasoningRevertInput) =>
          deps.getReasoningService().revert(sessionId, input),
      },
    },
    inspect: {
      state: {
        getActive: (sessionId: string) => deps.getReasoningService().getActiveState(sessionId),
      },
      checkpoints: {
        list: (sessionId: string) => deps.getReasoningService().listCheckpoints(sessionId),
        get: (sessionId: string, checkpointId: string) =>
          deps.getReasoningService().getCheckpoint(sessionId, checkpointId),
      },
      reverts: {
        list: (sessionId: string) => deps.getReasoningService().listReverts(sessionId),
        canRevertTo: (sessionId: string, checkpointId: string) =>
          deps.getReasoningService().canRevertTo(sessionId, checkpointId),
      },
    },
  };
}

export type RuntimeReasoningSurfaceMethods = ReturnType<typeof createReasoningSurfaceMethods>;

export function createReasoningAuthoritySurface(deps: ReasoningSurfaceDependencies) {
  return createReasoningSurfaceMethods(deps).authority;
}

export function createReasoningInspectSurface(deps: ReasoningSurfaceDependencies) {
  return createReasoningSurfaceMethods(deps).inspect;
}
