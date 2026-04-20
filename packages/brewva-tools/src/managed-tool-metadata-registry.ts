import type { ToolActionClass } from "@brewva/brewva-runtime";
import type { BrewvaToolRequiredCapability, BrewvaToolSurface } from "./types.js";

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
    "inspect.events.query",
    "inspect.task.getTargetDescriptor",
    "internal.onClearState",
    "internal.recordEvent",
  ]),
  git_status: metadata("base", "workspace_read"),
  git_diff: metadata("base", "workspace_read"),
  git_log: metadata("base", "workspace_read"),
  read_spans: metadata("base", "workspace_read", [
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  look_at: metadata("base", "workspace_read", [
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  toc_search: metadata("base", "workspace_read", [
    "inspect.events.query",
    "inspect.task.getTargetDescriptor",
    "internal.onClearState",
    "internal.recordEvent",
  ]),
  reasoning_checkpoint: metadata("control_plane", "control_state_mutation", [
    "authority.reasoning.recordCheckpoint",
  ]),
  reasoning_revert: metadata("control_plane", "control_state_mutation", [
    "authority.reasoning.revert",
  ]),
  session_compact: metadata("control_plane", "control_state_mutation", [
    "inspect.context.getCompactionInstructions",
    "inspect.context.getUsageRatio",
    "internal.recordEvent",
  ]),
  resource_lease: metadata("base", "budget_mutation", [
    "authority.tools.requestResourceLease",
    "authority.tools.cancelResourceLease",
    "inspect.tools.listResourceLeases",
  ]),
  exec: metadata("base", "local_exec_effectful", [
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
    "internal.resolveCredentialBindings",
    "internal.resolveSandboxApiKey",
  ]),
  lsp_diagnostics: metadata("base", "workspace_read", [
    "authority.tools.acquireParallelSlotAsync",
    "authority.tools.releaseParallelSlot",
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  process: metadata("base", "local_exec_effectful"),
  deliberation_memory: metadata("skill", "runtime_observe", ["inspect.task.getTargetDescriptor"]),
  narrative_memory: metadata("operator", "memory_write", [
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  knowledge_capture: metadata("skill", "workspace_patch", ["inspect.task.getTargetDescriptor"]),
  recall_search: metadata("skill", "workspace_read", [
    "inspect.events.list",
    "inspect.events.listSessionIds",
    "inspect.events.subscribe",
    "inspect.skills.getLoadReport",
    "inspect.skills.list",
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  recall_curate: metadata("operator", "memory_write", [
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  knowledge_search: metadata("skill", "workspace_read", ["inspect.task.getTargetDescriptor"]),
  precedent_audit: metadata("skill", "workspace_read", ["inspect.task.getTargetDescriptor"]),
  precedent_sweep: metadata("skill", "workspace_read", ["inspect.task.getTargetDescriptor"]),
  browser_open: metadata("skill", "local_exec_effectful", [
    "inspect.tools.explainAccess",
    "internal.recordEvent",
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
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  skill_load: metadata("control_plane", "control_state_mutation", [
    "authority.skills.activate",
    "inspect.skills.getConsumedOutputs",
    "inspect.skills.getReadiness",
  ]),
  tape_handoff: metadata("skill", "control_state_mutation", [
    "authority.events.recordTapeHandoff",
    "inspect.events.getTapeStatus",
  ]),
  tape_info: metadata("control_plane", "runtime_observe", [
    "inspect.context.getPressureStatus",
    "inspect.context.getUsage",
    "inspect.events.getTapeStatus",
    "inspect.reasoning.getActiveState",
  ]),
  tape_search: metadata("skill", "runtime_observe", ["inspect.events.searchTape"]),
  task_view_state: metadata("control_plane", "runtime_observe", ["inspect.task.getState"]),
  ast_grep_search: metadata("skill", "workspace_read"),
  ast_grep_replace: metadata("skill", "workspace_patch"),
  ledger_query: metadata("control_plane", "runtime_observe", ["inspect.ledger.query"]),
  lsp_find_references: metadata("skill", "workspace_read", [
    "authority.tools.acquireParallelSlotAsync",
    "authority.tools.releaseParallelSlot",
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  lsp_goto_definition: metadata("skill", "workspace_read", [
    "authority.tools.acquireParallelSlotAsync",
    "authority.tools.releaseParallelSlot",
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  lsp_prepare_rename: metadata("skill", "workspace_read", [
    "authority.tools.acquireParallelSlotAsync",
    "authority.tools.releaseParallelSlot",
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  lsp_rename: metadata("skill", "workspace_patch", [
    "authority.tools.acquireParallelSlotAsync",
    "authority.tools.releaseParallelSlot",
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  lsp_symbols: metadata("skill", "workspace_read", [
    "authority.tools.acquireParallelSlotAsync",
    "authority.tools.releaseParallelSlot",
    "inspect.task.getTargetDescriptor",
    "internal.recordEvent",
  ]),
  output_search: metadata("skill", "workspace_read", [
    "inspect.events.list",
    "internal.recordEvent",
  ]),
  workflow_status: metadata("control_plane", "runtime_observe", [
    "inspect.events.query",
    "inspect.session.getOpenToolCalls",
    "inspect.session.getUncleanShutdownDiagnostic",
    "inspect.session.listWorkerResults",
    "inspect.skills.getActiveState",
    "inspect.skills.getLatestFailure",
    "inspect.skills.getReadiness",
    "inspect.task.getState",
  ]),
  follow_up: metadata("skill", "schedule_mutation", [
    "authority.schedule.cancelIntent",
    "authority.schedule.createIntent",
    "inspect.schedule.getProjectionSnapshot",
    "inspect.schedule.listIntents",
  ]),
  worker_results_merge: metadata("skill", "runtime_observe", [
    "inspect.session.mergeWorkerResults",
  ]),
  worker_results_apply: metadata("skill", "workspace_patch", [
    "authority.session.applyMergedWorkerResults",
  ]),
  schedule_intent: metadata("skill", "schedule_mutation", [
    "inspect.schedule.getProjectionSnapshot",
    "inspect.schedule.listIntents",
    "authority.schedule.createIntent",
    "authority.schedule.updateIntent",
    "authority.schedule.cancelIntent",
  ]),
  skill_complete: metadata("control_plane", "control_state_mutation", [
    "authority.skills.recordCompletionFailure",
    "authority.verification.verify",
    "authority.skills.complete",
    "inspect.context.getUsage",
    "inspect.events.query",
    "inspect.events.queryStructured",
    "inspect.skills.getActive",
    "inspect.skills.getConsumedOutputs",
    "inspect.task.getTargetDescriptor",
    "inspect.skills.validateOutputs",
  ]),
  skill_promotion: metadata("skill", "memory_write"),
  subagent_run: metadata("skill", "delegation", ["internal.appendGuardedSupplementalBlocks"]),
  subagent_fanout: metadata("skill", "delegation", ["internal.appendGuardedSupplementalBlocks"]),
  subagent_status: metadata("skill", "delegation"),
  subagent_cancel: metadata("skill", "delegation"),
  task_add_item: metadata("control_plane", "memory_write", ["authority.task.addItem"]),
  task_record_acceptance: metadata("operator", "memory_write", ["authority.task.recordAcceptance"]),
  task_record_blocker: metadata("control_plane", "memory_write", ["authority.task.recordBlocker"]),
  task_resolve_blocker: metadata("control_plane", "memory_write", [
    "authority.task.resolveBlocker",
  ]),
  task_set_spec: metadata("control_plane", "memory_write", ["authority.task.setSpec"]),
  task_update_item: metadata("control_plane", "memory_write", ["authority.task.updateItem"]),
  cost_view: metadata("operator", "runtime_observe", ["inspect.cost.getSummary"]),
  obs_query: metadata("operator", "runtime_observe", [
    "inspect.events.list",
    "internal.recordEvent",
  ]),
  obs_slo_assert: metadata("operator", "runtime_observe", [
    "inspect.events.list",
    "internal.recordEvent",
  ]),
  obs_snapshot: metadata("operator", "runtime_observe", [
    "inspect.context.getPressureStatus",
    "inspect.context.getPromptStability",
    "inspect.context.getTransientReduction",
    "inspect.context.getUsage",
    "inspect.cost.getSummary",
    "inspect.events.getTapeStatus",
    "inspect.events.list",
    "inspect.task.getState",
  ]),
  optimization_continuity: metadata("skill", "runtime_observe"),
  iteration_fact: metadata("skill", "memory_write", [
    "authority.events.recordMetricObservation",
    "authority.events.recordGuardResult",
    "inspect.events.listGuardResults",
    "inspect.events.listMetricObservations",
  ]),
  rollback_last_patch: metadata("operator", "workspace_patch", [
    "authority.tools.rollbackLastPatchSet",
  ]),
} as const satisfies Record<string, ManagedBrewvaToolMetadataRegistryEntry>;
