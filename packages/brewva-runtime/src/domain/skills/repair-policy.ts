export const SKILL_REPAIR_ALLOWED_TOOL_NAMES = [
  "skill_complete",
  "workflow_status",
  "task_view_state",
  "ledger_query",
  "tape_info",
  "reasoning_checkpoint",
  "reasoning_revert",
  "session_compact",
] as const;

export const SKILL_REPAIR_MAX_ATTEMPTS = 2;
export const SKILL_REPAIR_MAX_TOOL_CALLS = 6;
export const SKILL_REPAIR_TOKEN_BUDGET = 12_000;
