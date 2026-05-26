import type { BrewvaToolRuntimeCapabilitiesPort } from "../../contracts/index.js";
import { openToolCalls } from "./tooling.js";
import type { FourPortRuntimeCapabilityContext } from "./types.js";

export function createFourPortRecoveryRuntimeOps(
  context: FourPortRuntimeCapabilityContext,
): BrewvaToolRuntimeCapabilitiesPort["recovery"] {
  return {
    getPosture(sessionId) {
      const recovery = context.runtime.tape.project(sessionId, "recovery_history");
      return {
        sessionId,
        latestCause: recovery.causes.at(-1) ?? null,
        causes: recovery.causes,
      };
    },
    getWorkingSet(sessionId) {
      return {
        sessionId,
        openToolCalls: openToolCalls(context.runtime, sessionId),
      };
    },
    listPending: () => [],
  };
}
