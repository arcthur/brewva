import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import { createGoalRuntimeController } from "../runtime-ops-goal-state.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildGoalRuntimeOps(ctx: HostedRuntimeOpsContext): HostedRuntimeOpsPort["goal"] {
  const goal = createGoalRuntimeController(ctx);
  return {
    state: { get: (sessionId) => goal.get(sessionId) },
    lifecycle: {
      start: (sessionId, input) => goal.start(sessionId, input),
      pause: (sessionId, input) => goal.pause(sessionId, input),
      resume: (sessionId, input) => goal.resume(sessionId, input),
      continueGoal: (sessionId, input) => goal.continueGoal(sessionId, input),
      clear: (sessionId, input) => goal.clear(sessionId, input),
      complete: (sessionId, input) => goal.complete(sessionId, input),
      block: (sessionId, input) => goal.block(sessionId, input),
    },
    usage: { observe: (sessionId, input) => goal.observe(sessionId, input) },
    continuation: { recordQueued: (sessionId, input) => goal.recordQueued(sessionId, input) },
  };
}
