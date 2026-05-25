import type { TaskItemStatus, TaskSpec } from "@brewva/brewva-vocabulary/task";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export function recordTaskSpec(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  spec: TaskSpec,
): void {
  runtime.capabilities.task.spec.set(sessionId, spec);
}

export function addTaskItem(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: { id?: string; text: string; status?: TaskItemStatus },
): ReturnType<BrewvaToolRuntime["capabilities"]["task"]["items"]["add"]> {
  return runtime.capabilities.task.items.add(sessionId, input);
}

export function updateTaskItem(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: { id: string; text?: string; status?: TaskItemStatus },
): ReturnType<BrewvaToolRuntime["capabilities"]["task"]["items"]["update"]> {
  return runtime.capabilities.task.items.update(sessionId, input);
}

export function recordTaskBlocker(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: { id?: string; message: string; source?: string; claimId?: string },
): ReturnType<BrewvaToolRuntime["capabilities"]["task"]["blockers"]["record"]> {
  return runtime.capabilities.task.blockers.record(sessionId, input);
}

export function resolveTaskBlocker(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  blockerId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["task"]["blockers"]["resolve"]> {
  return runtime.capabilities.task.blockers.resolve(sessionId, blockerId);
}

export function recordTaskAcceptance(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: { status: "pending" | "accepted" | "rejected"; decidedBy?: string; notes?: string },
): ReturnType<BrewvaToolRuntime["capabilities"]["task"]["acceptance"]["record"]> {
  return runtime.capabilities.task.acceptance.record(sessionId, input);
}

export function getTaskState(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["task"]["state"]["get"]> {
  return runtime.capabilities.task.state.get(sessionId);
}
