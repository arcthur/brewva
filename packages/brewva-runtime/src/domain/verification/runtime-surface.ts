import type { VerificationLevel } from "../../core/shared.js";
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
    checks: {
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
    },
  };
}

export type RuntimeVerificationSurfaceMethods = ReturnType<typeof createVerificationSurfaceMethods>;

export function createVerificationAuthoritySurface(deps: VerificationSurfaceDependencies) {
  return createVerificationSurfaceMethods(deps);
}
