import type { ToolActionClass } from "@brewva/brewva-runtime/governance";
import type { BrewvaToolRequiredCapability, BrewvaToolSurface } from "../contracts/index.js";

export interface ManagedBrewvaToolMetadataRegistryEntry {
  surface: BrewvaToolSurface;
  actionClass: ToolActionClass;
  requiredCapabilities?: readonly BrewvaToolRequiredCapability[];
}

function metadata<TSurface extends BrewvaToolSurface, TActionClass extends ToolActionClass>(
  surface: TSurface,
  actionClass: TActionClass,
): { surface: TSurface; actionClass: TActionClass };
function metadata<
  TSurface extends BrewvaToolSurface,
  TActionClass extends ToolActionClass,
  const TCapabilities extends readonly BrewvaToolRequiredCapability[],
>(
  surface: TSurface,
  actionClass: TActionClass,
  requiredCapabilities: TCapabilities,
): { surface: TSurface; actionClass: TActionClass; requiredCapabilities: TCapabilities };
function metadata(
  surface: BrewvaToolSurface,
  actionClass: ToolActionClass,
  requiredCapabilities?: readonly BrewvaToolRequiredCapability[],
): ManagedBrewvaToolMetadataRegistryEntry {
  return requiredCapabilities && requiredCapabilities.length > 0
    ? { surface, actionClass, requiredCapabilities }
    : { surface, actionClass };
}

export const MANAGED_BREWVA_TOOL_METADATA_BY_NAME = {
  agent_broadcast: metadata("operator", "external_side_effect"),
  agent_list: metadata("operator", "runtime_observe"),
  agent_send: metadata("operator", "external_side_effect"),
  grep: metadata("base", "workspace_read", [
    "inspect.events.records.query",
    "inspect.task.target.getDescriptor",
    "extensions.tools.onClearState",
    "extensions.tools.recordEvent",
  ]),
  git_status: metadata("base", "workspace_read"),
  git_diff: metadata("base", "workspace_read"),
  git_log: metadata("base", "workspace_read"),
  read_spans: metadata("base", "workspace_read", [
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  look_at: metadata("base", "workspace_read", [
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  toc_search: metadata("base", "workspace_read", [
    "inspect.events.records.query",
    "inspect.task.target.getDescriptor",
    "extensions.tools.onClearState",
    "extensions.tools.recordEvent",
  ]),
  reasoning_checkpoint: metadata("control_plane", "control_state_mutation", [
    "authority.reasoning.checkpoints.record",
  ]),
  reasoning_revert: metadata("control_plane", "control_state_mutation", [
    "authority.reasoning.reverts.revert",
  ]),
  workbench_compact: metadata("base", "memory_write", [
    "inspect.context.compaction.getInstructions",
    "inspect.context.usage.getRatio",
    "extensions.tools.recordEvent",
  ]),
  resource_lease: metadata("base", "budget_mutation", [
    "authority.tools.resourceLeases.request",
    "authority.tools.resourceLeases.cancel",
    "inspect.tools.resourceLeases.list",
  ]),
  exec: metadata("base", "local_exec_effectful", [
    "inspect.task.target.getDescriptor",
    "extensions.tools.onClearState",
    "extensions.tools.recordEvent",
    "extensions.tools.resolveCredentialBindings",
  ]),
  lsp_diagnostics: metadata("base", "workspace_read", [
    "authority.tools.parallel.acquireAsync",
    "authority.tools.parallel.release",
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  process: metadata("base", "local_exec_effectful", [
    "extensions.tools.onClearState",
    "extensions.tools.recordEvent",
  ]),
  workbench_note: metadata("base", "memory_write", ["authority.workbench.note"]),
  workbench_evict: metadata("base", "memory_write", ["authority.workbench.evict"]),
  workbench_undo_evict: metadata("base", "memory_write", ["authority.workbench.undoEviction"]),
  knowledge_capture: metadata("skill", "workspace_patch", ["inspect.task.target.getDescriptor"]),
  recall_search: metadata("skill", "workspace_read", [
    "inspect.events.log.getPath",
    "inspect.events.records.list",
    "inspect.events.log.listSessionIds",
    "inspect.events.records.subscribe",
    "inspect.skills.catalog.getLoadReport",
    "inspect.skills.catalog.list",
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  recall_curate: metadata("operator", "memory_write", [
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  knowledge_search: metadata("skill", "workspace_read", ["inspect.task.target.getDescriptor"]),
  precedent_audit: metadata("skill", "workspace_read", ["inspect.task.target.getDescriptor"]),
  precedent_sweep: metadata("skill", "workspace_read", ["inspect.task.target.getDescriptor"]),
  browser_open: metadata("skill", "local_exec_effectful", [
    "inspect.tools.access.explain",
    "extensions.tools.recordEvent",
  ]),
  browser_wait: metadata("skill", "local_exec_effectful"),
  browser_snapshot: metadata("skill", "local_exec_effectful"),
  browser_click: metadata("skill", "local_exec_effectful"),
  browser_fill: metadata("skill", "local_exec_effectful"),
  browser_get: metadata("skill", "local_exec_effectful"),
  browser_screenshot: metadata("skill", "local_exec_effectful"),
  browser_pdf: metadata("skill", "local_exec_effectful"),
  browser_diff_snapshot: metadata("skill", "local_exec_effectful"),
  browser_state_load: metadata("skill", "local_exec_effectful"),
  browser_state_save: metadata("skill", "local_exec_effectful"),
  browser_close: metadata("skill", "local_exec_effectful"),
  toc_document: metadata("skill", "workspace_read", [
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  question: metadata("base", "runtime_observe"),
  tape_handoff: metadata("skill", "control_state_mutation", [
    "authority.tape.handoff.record",
    "inspect.tape.status.get",
  ]),
  tape_info: metadata("control_plane", "runtime_observe", [
    "inspect.context.usage.getStatus",
    "inspect.context.usage.get",
    "inspect.tape.status.get",
    "inspect.reasoning.state.getActive",
  ]),
  tape_search: metadata("skill", "runtime_observe", ["inspect.tape.search.search"]),
  task_view_state: metadata("control_plane", "runtime_observe", ["inspect.task.state.get"]),
  ast_grep_search: metadata("skill", "workspace_read"),
  ast_grep_replace: metadata("skill", "workspace_patch"),
  ledger_query: metadata("control_plane", "runtime_observe", ["inspect.ledger.store.query"]),
  lsp_find_references: metadata("skill", "workspace_read", [
    "authority.tools.parallel.acquireAsync",
    "authority.tools.parallel.release",
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  lsp_goto_definition: metadata("skill", "workspace_read", [
    "authority.tools.parallel.acquireAsync",
    "authority.tools.parallel.release",
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  ast_prepare_rename: metadata("skill", "workspace_read", [
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  ast_rename_in_file: metadata("skill", "workspace_patch", [
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  lsp_symbols: metadata("skill", "workspace_read", [
    "authority.tools.parallel.acquireAsync",
    "authority.tools.parallel.release",
    "inspect.task.target.getDescriptor",
    "extensions.tools.recordEvent",
  ]),
  output_search: metadata("skill", "workspace_read", [
    "inspect.events.records.list",
    "extensions.tools.recordEvent",
  ]),
  workflow_status: metadata("control_plane", "runtime_observe", [
    "inspect.events.records.query",
    "inspect.session.lifecycle.getOpenToolCalls",
    "inspect.session.lifecycle.getUncleanShutdownDiagnostic",
    "inspect.session.workerResults.list",
    "inspect.task.state.get",
  ]),
  follow_up: metadata("skill", "schedule_mutation", [
    "authority.schedule.intents.cancel",
    "authority.schedule.intents.create",
    "inspect.schedule.intents.getProjectionSnapshot",
    "inspect.schedule.intents.list",
  ]),
  worker_results_merge: metadata("skill", "runtime_observe", [
    "inspect.session.workerResults.merge",
  ]),
  worker_results_apply: metadata("skill", "workspace_patch", [
    "authority.session.workerResults.applyMerged",
  ]),
  schedule_intent: metadata("skill", "schedule_mutation", [
    "inspect.schedule.intents.getProjectionSnapshot",
    "inspect.schedule.intents.list",
    "authority.schedule.intents.create",
    "authority.schedule.intents.update",
    "authority.schedule.intents.cancel",
  ]),
  subagent_run: metadata("skill", "delegation"),
  subagent_fanout: metadata("skill", "delegation"),
  subagent_fork: metadata("skill", "delegation"),
  subagent_run_diagnostic: metadata("control_plane", "delegation"),
  subagent_status: metadata("skill", "delegation"),
  subagent_cancel: metadata("skill", "delegation"),
  subagent_knowledge_adopt: metadata("skill", "delegation", ["extensions.tools.recordEvent"]),
  task_add_item: metadata("control_plane", "memory_write", ["authority.task.items.add"]),
  task_record_acceptance: metadata("operator", "memory_write", [
    "authority.task.acceptance.record",
  ]),
  task_record_blocker: metadata("control_plane", "memory_write", [
    "authority.task.blockers.record",
  ]),
  task_resolve_blocker: metadata("control_plane", "memory_write", [
    "authority.task.blockers.resolve",
  ]),
  task_set_spec: metadata("control_plane", "memory_write", ["authority.task.spec.set"]),
  task_update_item: metadata("control_plane", "memory_write", ["authority.task.items.update"]),
  cost_view: metadata("operator", "runtime_observe", ["inspect.cost.summary.get"]),
  obs_query: metadata("operator", "runtime_observe", [
    "inspect.events.records.list",
    "extensions.tools.recordEvent",
  ]),
  obs_slo_assert: metadata("operator", "runtime_observe", [
    "inspect.events.records.list",
    "extensions.tools.recordEvent",
  ]),
  obs_snapshot: metadata("operator", "runtime_observe", [
    "inspect.context.usage.getStatus",
    "inspect.context.prompt.getStability",
    "inspect.context.prompt.getTransientReduction",
    "inspect.context.usage.get",
    "inspect.cost.summary.get",
    "inspect.tape.status.get",
    "inspect.events.records.list",
    "inspect.task.state.get",
  ]),
  iteration_fact: metadata("skill", "memory_write", [
    "authority.events.recordMetricObservation",
    "authority.events.recordGuardResult",
    "inspect.events.iteration.listGuardResults",
    "inspect.events.iteration.listMetricObservations",
  ]),
  rollback_last_patch: metadata("operator", "workspace_patch", [
    "authority.tools.patches.rollbackLastPatchSet",
  ]),
} as const satisfies Record<string, ManagedBrewvaToolMetadataRegistryEntry>;
