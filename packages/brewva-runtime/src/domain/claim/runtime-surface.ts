import type { ClaimService } from "./claim.js";
import type { ClaimState } from "./types.js";

export interface ClaimSurfaceDependencies {
  getClaimService(): ClaimService;
  getClaimState(sessionId: string): ClaimState;
}

export function createClaimSurfaceMethods(deps: ClaimSurfaceDependencies) {
  return {
    facts: {
      upsert: (sessionId: string, input: Parameters<ClaimService["upsert"]>[1]) =>
        deps.getClaimService().upsert(sessionId, input),
      resolve: (sessionId: string, claimId: string) =>
        deps.getClaimService().resolve(sessionId, claimId),
    },
    state: {
      get: (sessionId: string) => deps.getClaimState(sessionId),
    },
  };
}

export type RuntimeClaimSurfaceMethods = ReturnType<typeof createClaimSurfaceMethods>;

export function createClaimAuthoritySurface(deps: ClaimSurfaceDependencies) {
  const methods = createClaimSurfaceMethods(deps);
  return {
    facts: methods.facts,
  };
}

export function createClaimInspectSurface(deps: ClaimSurfaceDependencies) {
  const methods = createClaimSurfaceMethods(deps);
  return {
    state: methods.state,
  };
}
