import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { TruthService } from "./truth.js";
import type {
  TruthFactResolveResult,
  TruthFactSeverity,
  TruthFactStatus,
  TruthFactUpsertResult,
  TruthState,
} from "./types.js";

export interface TruthSurfaceDependencies {
  getTruthService(): TruthService;
  getTruthState(sessionId: string): TruthState;
}

export interface RuntimeTruthSurfaceMethods {
  getState(sessionId: string): TruthState;
  upsertFact(
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: TruthFactSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: TruthFactStatus;
    },
  ): TruthFactUpsertResult;
  resolveFact(sessionId: string, truthFactId: string): TruthFactResolveResult;
}

export const truthSurfaceContribution = {
  authority: ["upsertFact", "resolveFact"],
  inspect: ["getState"],
} as const satisfies SurfaceContribution<RuntimeTruthSurfaceMethods>;

export function createTruthSurfaceMethods(
  deps: TruthSurfaceDependencies,
): RuntimeTruthSurfaceMethods {
  return {
    getState: (sessionId: string) => deps.getTruthState(sessionId),
    upsertFact: (sessionId: string, input) =>
      deps.getTruthService().upsertTruthFact(sessionId, input),
    resolveFact: (sessionId: string, truthFactId: string) =>
      deps.getTruthService().resolveTruthFact(sessionId, truthFactId),
  };
}

export const truthRuntimeSurface = defineRuntimeSurfaceModule({
  name: "truth",
  createMethods: createTruthSurfaceMethods,
  contribution: truthSurfaceContribution,
});
