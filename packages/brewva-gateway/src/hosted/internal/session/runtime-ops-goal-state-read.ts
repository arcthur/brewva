import {
  foldGoalEvents,
  GOAL_BLOCKER_OBSERVED_EVENT_TYPE,
  GOAL_CLEARED_EVENT_TYPE,
  GOAL_REPLACED_EVENT_TYPE,
  GOAL_STARTED_EVENT_TYPE,
  type GoalLifecycleInput,
  type GoalState,
} from "@brewva/brewva-vocabulary/goal";
import type { HostedRuntimeOpsContext } from "./runtime-ops-context.js";

export const BLOCKED_REQUIRED_COUNT = 3;
export const TERMINAL_GOAL_STATUSES = new Set(["complete", "blocked"]);

export function normalizeNow(input: Pick<GoalLifecycleInput, "now"> | undefined): number {
  return typeof input?.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
}

export function inputPayload(input: GoalLifecycleInput | undefined): Record<string, unknown> {
  return input && typeof input === "object" ? { ...input } : {};
}

export function createGoalRuntimeReader(ctx: HostedRuntimeOpsContext) {
  function goalEvents(sessionId: string) {
    return ctx.listEvents(sessionId).filter((event) => event.type.startsWith("goal."));
  }

  function readGoal(sessionId: string): GoalState | null {
    return foldGoalEvents(goalEvents(sessionId));
  }

  function activeGoal(sessionId: string): GoalState | null {
    const state = readGoal(sessionId);
    return state?.status === "active" ? state : null;
  }

  function countConsecutiveBlockers(sessionId: string, blockerKey: string): number {
    const events = goalEvents(sessionId);
    const seenGoalTurns = new Set<string>();
    let count = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;
      if (
        event.type === GOAL_STARTED_EVENT_TYPE ||
        event.type === GOAL_REPLACED_EVENT_TYPE ||
        event.type === GOAL_CLEARED_EVENT_TYPE
      ) {
        break;
      }
      if (event.type !== GOAL_BLOCKER_OBSERVED_EVENT_TYPE) continue;
      const payload = event.payload ?? {};
      const goalTurnKey =
        typeof payload.goalTurnKey === "string" && payload.goalTurnKey.trim()
          ? payload.goalTurnKey.trim()
          : typeof payload.turnId === "string" && payload.turnId.trim()
            ? payload.turnId.trim()
            : typeof event.turn === "number"
              ? `turn:${event.turn}`
              : "unattributed";
      if (seenGoalTurns.has(goalTurnKey)) continue;
      seenGoalTurns.add(goalTurnKey);
      if (payload.blockerKey !== blockerKey) break;
      count += 1;
    }
    return count;
  }

  return { activeGoal, countConsecutiveBlockers, readGoal };
}
