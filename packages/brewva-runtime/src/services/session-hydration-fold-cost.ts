import type { SessionHydrationFold } from "./session-hydration-fold.js";
import { readEventPayload } from "./session-hydration-fold.js";

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
