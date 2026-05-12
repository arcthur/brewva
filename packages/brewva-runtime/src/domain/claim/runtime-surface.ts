import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { ClaimService } from "./claim.js";
import type {
  ClaimResolveResult,
  ClaimSeverity,
  ClaimStatus,
  ClaimUpsertResult,
  ClaimState,
} from "./types.js";

export interface ClaimSurfaceDependencies {
  getClaimService(): ClaimService;
  getClaimState(sessionId: string): ClaimState;
}

export interface RuntimeClaimSurfaceMethods {
  getState(sessionId: string): ClaimState;
  upsert(
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: ClaimSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: ClaimStatus;
    },
  ): ClaimUpsertResult;
  resolve(sessionId: string, claimId: string): ClaimResolveResult;
}

export const claimSurfaceContribution = {
  authority: ["upsert", "resolve"],
  inspect: ["getState"],
} as const satisfies SurfaceContribution<RuntimeClaimSurfaceMethods>;

export function createClaimSurfaceMethods(
  deps: ClaimSurfaceDependencies,
): RuntimeClaimSurfaceMethods {
  return {
    getState: (sessionId: string) => deps.getClaimState(sessionId),
    upsert: (sessionId: string, input) => deps.getClaimService().upsert(sessionId, input),
    resolve: (sessionId: string, claimId: string) =>
      deps.getClaimService().resolve(sessionId, claimId),
  };
}

export const claimRuntimeSurface = defineRuntimeSurfaceModule({
  name: "claim",
  createMethods: createClaimSurfaceMethods,
  contribution: claimSurfaceContribution,
});
