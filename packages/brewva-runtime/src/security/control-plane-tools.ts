// Control-plane tools bypass normal skill effect authorization and budget enforcement.
// They must remain available to recover from partial failures and to complete lifecycle actions.
export const CONTROL_PLANE_TOOLS = [
  "workflow_status",
  "task_view_state",
  "task_set_spec",
  "task_add_item",
  "task_update_item",
  "task_record_blocker",
  "task_resolve_blocker",
  "resource_lease",
  "ledger_query",
  "cost_view",
  "tape_handoff",
  "tape_info",
  "tape_search",
  "recall_search",
  "reasoning_checkpoint",
  "reasoning_revert",
  "workbench_compact",
  "rollback_last_patch",
  "follow_up",
  "schedule_intent",
];

// Tools that remain usable when the forced-compaction gate is armed.
// Keep this list minimal: anything allowed here can bypass "compact-first" recovery.
export const CONTEXT_CRITICAL_ALLOWED_TOOLS = ["workbench_compact"];
