import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { ReasoningService } from "./reasoning.js";
import type {
  ActiveReasoningBranchState,
  ReasoningCheckpointRecord,
  ReasoningRevertInput,
  ReasoningRevertRecord,
  RecordReasoningCheckpointInput,
} from "./types.js";

export interface ReasoningSurfaceDependencies {
  getReasoningService(): ReasoningService;
}

export interface RuntimeReasoningSurfaceMethods {
  recordCheckpoint(
    sessionId: string,
    input: RecordReasoningCheckpointInput,
  ): ReasoningCheckpointRecord;
  revert(sessionId: string, input: ReasoningRevertInput): ReasoningRevertRecord;
  getActiveState(sessionId: string): ActiveReasoningBranchState;
  listCheckpoints(sessionId: string): ReasoningCheckpointRecord[];
  getCheckpoint(sessionId: string, checkpointId: string): ReasoningCheckpointRecord | undefined;
  listReverts(sessionId: string): ReasoningRevertRecord[];
  canRevertTo(sessionId: string, checkpointId: string): boolean;
}

export const reasoningSurfaceContribution = {
  authority: ["recordCheckpoint", "revert"],
  inspect: ["getActiveState", "listCheckpoints", "getCheckpoint", "listReverts", "canRevertTo"],
} as const satisfies SurfaceContribution<RuntimeReasoningSurfaceMethods>;

export function createReasoningSurfaceMethods(
  deps: ReasoningSurfaceDependencies,
): RuntimeReasoningSurfaceMethods {
  return {
    recordCheckpoint: (sessionId: string, input: RecordReasoningCheckpointInput) =>
      deps.getReasoningService().recordCheckpoint(sessionId, input),
    revert: (sessionId: string, input: ReasoningRevertInput) =>
      deps.getReasoningService().revert(sessionId, input),
    getActiveState: (sessionId: string) => deps.getReasoningService().getActiveState(sessionId),
    listCheckpoints: (sessionId: string) => deps.getReasoningService().listCheckpoints(sessionId),
    getCheckpoint: (sessionId: string, checkpointId: string) =>
      deps.getReasoningService().getCheckpoint(sessionId, checkpointId),
    listReverts: (sessionId: string) => deps.getReasoningService().listReverts(sessionId),
    canRevertTo: (sessionId: string, checkpointId: string) =>
      deps.getReasoningService().canRevertTo(sessionId, checkpointId),
  };
}

export const reasoningRuntimeSurface = defineRuntimeSurfaceModule({
  name: "reasoning",
  createMethods: createReasoningSurfaceMethods,
  contribution: reasoningSurfaceContribution,
});
