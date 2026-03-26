import type { TaskItemStatus, VerificationLevel } from "../contracts/index.js";

export const TASK_AGENT_VERIFICATION_LEVEL_VALUES = ["smoke", "targeted", "full", "none"] as const;

export type TaskAgentVerificationLevel = (typeof TASK_AGENT_VERIFICATION_LEVEL_VALUES)[number];

export const TASK_AGENT_VERIFICATION_LEVEL_ALIASES = {
  inspection: "none",
  investigate: "none",
  readonly: "none",
  read_only: "none",
  "read-only": "none",
} as const satisfies Readonly<Record<string, TaskAgentVerificationLevel>>;

export const TASK_AGENT_VERIFICATION_LEVEL_RUNTIME_MAP = {
  smoke: "quick",
  targeted: "standard",
  full: "strict",
  none: "none",
} as const satisfies Readonly<Record<TaskAgentVerificationLevel, string>>;

const TASK_RUNTIME_TO_AGENT_VERIFICATION_LEVEL = {
  quick: "smoke",
  standard: "targeted",
  strict: "full",
} as const satisfies Readonly<
  Record<VerificationLevel, Exclude<TaskAgentVerificationLevel, "none">>
>;

export const TASK_AGENT_ITEM_STATUS_VALUES = ["pending", "in_progress", "done", "blocked"] as const;

export type TaskAgentItemStatus = (typeof TASK_AGENT_ITEM_STATUS_VALUES)[number];

export const TASK_AGENT_ITEM_STATUS_ALIASES = {
  "in-progress": "in_progress",
} as const satisfies Readonly<Record<string, TaskAgentItemStatus>>;

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
  const normalized = normalizeSurfaceToken(level);
  if (!normalized) {
    return undefined;
  }
  return normalized in TASK_RUNTIME_TO_AGENT_VERIFICATION_LEVEL
    ? TASK_RUNTIME_TO_AGENT_VERIFICATION_LEVEL[
        normalized as keyof typeof TASK_RUNTIME_TO_AGENT_VERIFICATION_LEVEL
      ]
    : normalized;
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
