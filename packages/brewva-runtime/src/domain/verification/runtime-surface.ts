import type { VerificationLevel } from "../../core/shared.js";
import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { SessionLifecycleService } from "../sessions/api.js";
import type { VerificationReport } from "./types.js";
import type { VerificationService } from "./verification.js";

export interface VerificationSurfaceDependencies {
  getSessionLifecycleService(): SessionLifecycleService;
  getVerificationService(): VerificationService;
  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport;
}

export function createVerificationSurfaceMethods(deps: VerificationSurfaceDependencies) {
  return {
    evaluate: (sessionId: string, level?: VerificationLevel) =>
      deps.evaluateCompletion(sessionId, level),
    verify: async (
      sessionId: string,
      level?: VerificationLevel,
      options?: Parameters<VerificationService["verifyCompletion"]>[2],
    ) => {
      deps.getSessionLifecycleService().ensureHydrated(sessionId);
      return await deps.getVerificationService().verifyCompletion(sessionId, level, options);
    },
  };
}

export type RuntimeVerificationSurfaceMethods = ReturnType<typeof createVerificationSurfaceMethods>;

export const verificationSurfaceContribution = {
  authority: ["evaluate", "verify"],
} as const satisfies SurfaceContribution<RuntimeVerificationSurfaceMethods>;

export const verificationRuntimeSurface = defineRuntimeSurfaceModule({
  name: "verification",
  createMethods: createVerificationSurfaceMethods,
  contribution: verificationSurfaceContribution,
});
