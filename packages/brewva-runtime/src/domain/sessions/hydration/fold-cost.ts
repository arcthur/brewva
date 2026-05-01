import type { SessionHydrationFold } from "./fold.js";
import { readEventPayload } from "./fold.js";

export const SESSION_HYDRATION_COST_TURN_LIFECYCLE_PLACEMENT = {
  foldId: "session_hydration_cost",
  source: "packages/brewva-runtime/src/domain/sessions/hydration/fold-cost.ts",
  observes: ["execution_recorded", "terminal_recorded"],
  role: "hydrate",
} as const;

export function createCostHydrationFold(): SessionHydrationFold<null> {
  return {
    domain: "cost",
    initial() {
      return null;
    },
    fold(_state, event, context) {
      if (
        event.type === "tool_call_marked" &&
        !context.replayCostTail &&
        !context.replayCheckpointTurnTransient
      ) {
        return;
      }
      if (event.type === "cost_update" && !context.replayCostTail) {
        return;
      }
      if (event.type !== "tool_call_marked" && event.type !== "cost_update") {
        return;
      }
      context.callbacks.replayCostStateEvent(context.sessionId, event, readEventPayload(event), {
        checkpointTurnTransient: context.replayCheckpointTurnTransient,
      });
    },
    apply() {},
  };
}
