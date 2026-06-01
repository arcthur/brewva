import type { GoalLifecycleInput } from "@brewva/brewva-vocabulary/goal";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export function getGoalState(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["goal"]["state"]["get"]> {
  return runtime.capabilities.goal.state.get(sessionId);
}

export function completeGoal(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: GoalLifecycleInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["goal"]["lifecycle"]["complete"]> {
  return runtime.capabilities.goal.lifecycle.complete(sessionId, input);
}

export function blockGoal(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: GoalLifecycleInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["goal"]["lifecycle"]["block"]> {
  return runtime.capabilities.goal.lifecycle.block(sessionId, input);
}
