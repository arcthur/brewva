import type { TaskItemStatus } from "./types.js";

export const TASK_AGENT_ITEM_STATUS_VALUES = ["pending", "in_progress", "done", "blocked"] as const;

export type TaskAgentItemStatus = (typeof TASK_AGENT_ITEM_STATUS_VALUES)[number];

export const TASK_AGENT_ITEM_STATUS_RUNTIME_MAP = {
  pending: "todo",
  in_progress: "doing",
  done: "done",
  blocked: "blocked",
} as const satisfies Readonly<Record<TaskAgentItemStatus, string>>;

const TASK_RUNTIME_TO_AGENT_ITEM_STATUS = {
  todo: "pending",
  doing: "in_progress",
  done: "done",
  blocked: "blocked",
} as const satisfies Readonly<Record<TaskItemStatus, TaskAgentItemStatus>>;

function normalizeSurfaceToken(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function formatTaskVerificationLevelForSurface(
  level: string | undefined | null,
): string | undefined {
  return normalizeSurfaceToken(level);
}

export function formatTaskItemStatusForSurface(
  status: string | undefined | null,
): string | undefined {
  const normalized = normalizeSurfaceToken(status);
  if (!normalized) {
    return undefined;
  }
  return normalized in TASK_RUNTIME_TO_AGENT_ITEM_STATUS
    ? TASK_RUNTIME_TO_AGENT_ITEM_STATUS[
        normalized as keyof typeof TASK_RUNTIME_TO_AGENT_ITEM_STATUS
      ]
    : normalized;
}
