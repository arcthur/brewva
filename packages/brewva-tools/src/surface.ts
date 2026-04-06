import type { BrewvaToolSurface } from "./types.js";

export type { BrewvaToolSurface } from "./types.js";

export const BREWVA_TOOL_SURFACE_BY_NAME = {
  agent_broadcast: "operator",
  agent_list: "operator",
  agent_send: "operator",
  grep: "base",
  git_status: "base",
  git_diff: "base",
  git_log: "base",
  read_spans: "base",
  look_at: "base",
  toc_search: "base",
  reasoning_checkpoint: "control_plane",
  reasoning_revert: "control_plane",
  session_compact: "control_plane",
  resource_lease: "base",
  exec: "base",
  lsp_diagnostics: "base",
  process: "base",
  deliberation_memory: "skill",
  narrative_memory: "operator",
  knowledge_capture: "skill",
  knowledge_search: "skill",
  precedent_audit: "skill",
  precedent_sweep: "skill",
  browser_open: "skill",
  browser_wait: "skill",
  browser_snapshot: "skill",
  browser_click: "skill",
  browser_fill: "skill",
  browser_get: "skill",
  browser_screenshot: "skill",
  browser_pdf: "skill",
  browser_diff_snapshot: "skill",
  browser_state_load: "skill",
  browser_state_save: "skill",
  browser_close: "skill",
  toc_document: "skill",
  skill_load: "control_plane",
  tape_handoff: "skill",
  tape_info: "control_plane",
  tape_search: "skill",
  task_view_state: "control_plane",
  ast_grep_search: "skill",
  ast_grep_replace: "skill",
  ledger_query: "control_plane",
  lsp_find_references: "skill",
  lsp_goto_definition: "skill",
  lsp_prepare_rename: "skill",
  lsp_rename: "skill",
  lsp_symbols: "skill",
  output_search: "skill",
  workflow_status: "control_plane",
  follow_up: "skill",
  worker_results_merge: "skill",
  worker_results_apply: "skill",
  schedule_intent: "skill",
  skill_complete: "control_plane",
  skill_promotion: "skill",
  subagent_run: "skill",
  subagent_fanout: "skill",
  subagent_status: "skill",
  subagent_cancel: "skill",
  task_add_item: "control_plane",
  task_record_acceptance: "operator",
  task_record_blocker: "control_plane",
  task_resolve_blocker: "control_plane",
  task_set_spec: "control_plane",
  task_update_item: "control_plane",
  cost_view: "operator",
  obs_query: "operator",
  obs_slo_assert: "operator",
  obs_snapshot: "operator",
  optimization_continuity: "skill",
  iteration_fact: "skill",
  rollback_last_patch: "operator",
} as const satisfies Record<string, BrewvaToolSurface>;

function toolNamesBySurface<S extends BrewvaToolSurface>(surface: S) {
  return (Object.entries(BREWVA_TOOL_SURFACE_BY_NAME) as [string, BrewvaToolSurface][])
    .filter((entry): entry is [string, S] => entry[1] === surface)
    .map(([name]) => name)
    .toSorted();
}

export const BASE_BREWVA_TOOL_NAMES = toolNamesBySurface("base");
export const SKILL_BREWVA_TOOL_NAMES = toolNamesBySurface("skill");
export const CONTROL_PLANE_BREWVA_TOOL_NAMES = toolNamesBySurface("control_plane");
export const OPERATOR_BREWVA_TOOL_NAMES = toolNamesBySurface("operator");
export const MANAGED_BREWVA_TOOL_NAMES = Object.keys(BREWVA_TOOL_SURFACE_BY_NAME).toSorted();

export function getBrewvaToolSurface(name: string): BrewvaToolSurface | undefined {
  return BREWVA_TOOL_SURFACE_BY_NAME[name as keyof typeof BREWVA_TOOL_SURFACE_BY_NAME];
}

export function isManagedBrewvaToolName(name: string): boolean {
  return Object.hasOwn(BREWVA_TOOL_SURFACE_BY_NAME, name);
}
