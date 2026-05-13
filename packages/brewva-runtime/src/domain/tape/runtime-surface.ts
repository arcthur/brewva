import type {
  TapeHandoffResult,
  TapeSearchResult,
  TapeSearchScope,
  TapeStatusState,
} from "../context/api.js";

export interface TapeSurfaceDependencies {
  getTapeService(): {
    getTapeStatus(sessionId: string): TapeStatusState;
    getPressureThresholds(): TapeStatusState["thresholds"];
    recordTapeHandoff(
      sessionId: string,
      input: { name: string; summary?: string; nextSteps?: string },
    ): TapeHandoffResult;
    searchTape(
      sessionId: string,
      input: { query: string; scope?: TapeSearchScope; limit?: number },
    ): TapeSearchResult;
  };
}

export function createTapeSurfaceMethods(deps: TapeSurfaceDependencies) {
  return {
    authority: {
      handoff: {
        record: (
          sessionId: string,
          input: { name: string; summary?: string; nextSteps?: string },
        ) => deps.getTapeService().recordTapeHandoff(sessionId, input),
      },
    },
    inspect: {
      status: {
        get: (sessionId: string) => deps.getTapeService().getTapeStatus(sessionId),
        getPressureThresholds: () => deps.getTapeService().getPressureThresholds(),
      },
      search: {
        search: (
          sessionId: string,
          input: { query: string; scope?: TapeSearchScope; limit?: number },
        ) => deps.getTapeService().searchTape(sessionId, input),
      },
    },
  };
}

export type RuntimeTapeSurfaceMethods = ReturnType<typeof createTapeSurfaceMethods>;

export function createTapeAuthoritySurface(deps: TapeSurfaceDependencies) {
  return createTapeSurfaceMethods(deps).authority;
}

export function createTapeInspectSurface(deps: TapeSurfaceDependencies) {
  return createTapeSurfaceMethods(deps).inspect;
}
