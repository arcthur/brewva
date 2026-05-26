import type {
  DelegationRunRecord,
  DelegationRunStatus,
} from "@brewva/brewva-vocabulary/delegation";

export type SubagentActivityTone = "running" | "success" | "warning" | "error" | "muted";

export interface SubagentActivityItem {
  runId: string;
  status: DelegationRunStatus;
  roleLabel: string;
  title: string;
  detail: string | undefined;
  icon: string;
  tone: SubagentActivityTone;
  live: boolean;
  cancelable: boolean;
  workerSessionId?: string;
}

export interface SubagentActivityOptions {
  limit?: number;
}

const DEFAULT_ACTIVITY_LIMIT = 5;
const UPPERCASE_TOKENS = new Set(["api", "cli", "mcp", "qa", "tui", "ui"]);

function humanizeToken(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (UPPERCASE_TOKENS.has(lower)) {
        return lower.toUpperCase();
      }
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function isActiveRun(run: DelegationRunRecord & { live?: boolean }): boolean {
  return (
    run.status === "pending" ||
    run.status === "running" ||
    run.status === "blocked" ||
    run.live === true
  );
}

function statusTone(status: DelegationRunStatus): SubagentActivityTone {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "blocked":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "warning";
    default:
      return "muted";
  }
}

function statusIcon(status: DelegationRunStatus): string {
  switch (status) {
    case "pending":
      return "◌";
    case "running":
      return "◔";
    case "blocked":
      return "◒";
    case "completed":
      return "●";
    case "failed":
      return "◍";
    case "cancelled":
      return "○";
    default:
      return "?";
  }
}

function compareActivityRuns(
  left: DelegationRunRecord & { live?: boolean },
  right: DelegationRunRecord & { live?: boolean },
): number {
  const active = Number(isActiveRun(right)) - Number(isActiveRun(left));
  if (active !== 0) {
    return active;
  }
  const updated = right.updatedAt - left.updatedAt;
  if (updated !== 0) {
    return updated;
  }
  return right.createdAt - left.createdAt;
}

function projectRun(
  run: DelegationRunRecord & { live?: boolean; cancelable?: boolean },
): SubagentActivityItem {
  const roleLabel = humanizeToken(
    firstNonEmpty(run.targetName, run.agent, run.delegate) ?? "Subagent",
  );
  const title =
    firstNonEmpty(run.label, run.nickname, run.taskName, run.summary, run.delegate) ?? run.runId;
  const detail = firstNonEmpty(run.summary, run.workerSessionId);
  return {
    runId: run.runId,
    status: run.status,
    roleLabel,
    title,
    detail: detail === title ? undefined : detail,
    icon: statusIcon(run.status),
    tone: statusTone(run.status),
    live: run.live === true,
    cancelable: run.cancelable === true,
    workerSessionId: run.workerSessionId,
  };
}

export function selectSubagentActivityItems(
  runs: readonly (DelegationRunRecord & { live?: boolean; cancelable?: boolean })[],
  options: SubagentActivityOptions = {},
): SubagentActivityItem[] {
  const limit = Math.max(0, options.limit ?? DEFAULT_ACTIVITY_LIMIT);
  if (limit === 0 || runs.length === 0) {
    return [];
  }
  return runs.toSorted(compareActivityRuns).slice(0, limit).map(projectRun);
}
