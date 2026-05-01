import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
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

export interface RuntimeTapeSurfaceMethods {
  getTapeStatus(sessionId: string): TapeStatusState;
  getTapePressureThresholds(): TapeStatusState["thresholds"];
  recordTapeHandoff(
    sessionId: string,
    input: { name: string; summary?: string; nextSteps?: string },
  ): TapeHandoffResult;
  searchTape(
    sessionId: string,
    input: { query: string; scope?: TapeSearchScope; limit?: number },
  ): TapeSearchResult;
}

export const tapeSurfaceContribution = {
  authority: ["recordTapeHandoff"],
  inspect: ["getTapeStatus", "getTapePressureThresholds", "searchTape"],
} as const satisfies SurfaceContribution<RuntimeTapeSurfaceMethods>;

export function createTapeSurfaceMethods(deps: TapeSurfaceDependencies): RuntimeTapeSurfaceMethods {
  return {
    getTapeStatus: (sessionId: string) => deps.getTapeService().getTapeStatus(sessionId),
    getTapePressureThresholds: () => deps.getTapeService().getPressureThresholds(),
    recordTapeHandoff: (sessionId: string, input) =>
      deps.getTapeService().recordTapeHandoff(sessionId, input),
    searchTape: (sessionId: string, input) => deps.getTapeService().searchTape(sessionId, input),
  };
}

export const tapeRuntimeSurface = defineRuntimeSurfaceModule({
  name: "tape",
  createMethods: createTapeSurfaceMethods,
  contribution: tapeSurfaceContribution,
});
