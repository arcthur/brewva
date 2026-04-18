import type { BrewvaToolRequiredCapability, BrewvaToolSurface } from "./types.js";

export interface ManagedBrewvaToolMetadataRegistryEntry {
  surface: BrewvaToolSurface;
  requiredCapabilities?: readonly BrewvaToolRequiredCapability[];
}

export const MANAGED_BREWVA_TOOL_METADATA_BY_NAME = {
  agent_broadcast: { surface: "operator" },
  agent_list: { surface: "operator" },
  agent_send: { surface: "operator" },
  grep: {
    surface: "base",
    requiredCapabilities: [
      "inspect.events.query",
      "inspect.task.getTargetDescriptor",
      "internal.onClearState",
      "internal.recordEvent",
    ],
  },
  git_status: { surface: "base" },
  git_diff: { surface: "base" },
  git_log: { surface: "base" },
  read_spans: {
    surface: "base",
    requiredCapabilities: ["inspect.task.getTargetDescriptor", "internal.recordEvent"],
  },
  look_at: {
    surface: "base",
    requiredCapabilities: ["inspect.task.getTargetDescriptor", "internal.recordEvent"],
  },
  toc_search: {
    surface: "base",
    requiredCapabilities: [
      "inspect.events.query",
      "inspect.task.getTargetDescriptor",
      "internal.onClearState",
      "internal.recordEvent",
    ],
  },
  reasoning_checkpoint: {
    surface: "control_plane",
    requiredCapabilities: ["authority.reasoning.recordCheckpoint"],
  },
  reasoning_revert: {
    surface: "control_plane",
    requiredCapabilities: ["authority.reasoning.revert"],
  },
  session_compact: {
    surface: "control_plane",
    requiredCapabilities: [
      "inspect.context.getCompactionInstructions",
      "inspect.context.getUsageRatio",
      "internal.recordEvent",
    ],
  },
  resource_lease: {
    surface: "base",
    requiredCapabilities: [
      "authority.tools.requestResourceLease",
      "authority.tools.cancelResourceLease",
      "inspect.tools.listResourceLeases",
    ],
  },
  exec: {
    surface: "base",
    requiredCapabilities: [
      "inspect.task.getTargetDescriptor",
      "internal.recordEvent",
      "internal.resolveCredentialBindings",
      "internal.resolveSandboxApiKey",
    ],
  },
  lsp_diagnostics: {
    surface: "base",
    requiredCapabilities: [
      "authority.tools.acquireParallelSlotAsync",
      "authority.tools.releaseParallelSlot",
      "inspect.task.getTargetDescriptor",
      "internal.recordEvent",
    ],
  },
  process: { surface: "base" },
  deliberation_memory: {
    surface: "skill",
    requiredCapabilities: ["inspect.task.getTargetDescriptor"],
  },
  narrative_memory: {
    surface: "operator",
    requiredCapabilities: ["inspect.task.getTargetDescriptor", "internal.recordEvent"],
  },
  knowledge_capture: {
    surface: "skill",
    requiredCapabilities: ["inspect.task.getTargetDescriptor"],
  },
  recall_search: {
    surface: "skill",
    requiredCapabilities: [
      "inspect.events.list",
      "inspect.events.listSessionIds",
      "inspect.events.subscribe",
      "inspect.skills.getLoadReport",
      "inspect.skills.list",
      "inspect.task.getTargetDescriptor",
      "internal.recordEvent",
    ],
  },
  recall_curate: {
    surface: "operator",
    requiredCapabilities: ["inspect.task.getTargetDescriptor", "internal.recordEvent"],
  },
  knowledge_search: {
    surface: "skill",
    requiredCapabilities: ["inspect.task.getTargetDescriptor"],
  },
  precedent_audit: {
    surface: "skill",
    requiredCapabilities: ["inspect.task.getTargetDescriptor"],
  },
  precedent_sweep: {
    surface: "skill",
    requiredCapabilities: ["inspect.task.getTargetDescriptor"],
  },
  browser_open: {
    surface: "skill",
    requiredCapabilities: ["inspect.tools.explainAccess", "internal.recordEvent"],
  },
  browser_wait: { surface: "skill" },
  browser_snapshot: { surface: "skill" },
  browser_click: { surface: "skill" },
  browser_fill: { surface: "skill" },
  browser_get: { surface: "skill" },
  browser_screenshot: { surface: "skill" },
  browser_pdf: { surface: "skill" },
  browser_diff_snapshot: { surface: "skill" },
  browser_state_load: { surface: "skill" },
  browser_state_save: { surface: "skill" },
  browser_close: { surface: "skill" },
  toc_document: {
    surface: "skill",
    requiredCapabilities: ["inspect.task.getTargetDescriptor", "internal.recordEvent"],
  },
  skill_load: {
    surface: "control_plane",
    requiredCapabilities: ["authority.skills.activate", "inspect.skills.getConsumedOutputs"],
  },
  tape_handoff: {
    surface: "skill",
    requiredCapabilities: ["authority.events.recordTapeHandoff", "inspect.events.getTapeStatus"],
  },
  tape_info: {
    surface: "control_plane",
    requiredCapabilities: [
      "inspect.context.getPressureStatus",
      "inspect.context.getUsage",
      "inspect.events.getTapeStatus",
      "inspect.reasoning.getActiveState",
    ],
  },
  tape_search: {
    surface: "skill",
    requiredCapabilities: ["inspect.events.searchTape"],
  },
  task_view_state: {
    surface: "control_plane",
    requiredCapabilities: ["inspect.task.getState"],
  },
  ast_grep_search: { surface: "skill" },
  ast_grep_replace: { surface: "skill" },
  ledger_query: {
    surface: "control_plane",
    requiredCapabilities: ["inspect.ledger.query"],
  },
  lsp_find_references: {
    surface: "skill",
    requiredCapabilities: [
      "authority.tools.acquireParallelSlotAsync",
      "authority.tools.releaseParallelSlot",
      "inspect.task.getTargetDescriptor",
      "internal.recordEvent",
    ],
  },
  lsp_goto_definition: {
    surface: "skill",
    requiredCapabilities: [
      "authority.tools.acquireParallelSlotAsync",
      "authority.tools.releaseParallelSlot",
      "inspect.task.getTargetDescriptor",
      "internal.recordEvent",
    ],
  },
  lsp_prepare_rename: {
    surface: "skill",
    requiredCapabilities: [
      "authority.tools.acquireParallelSlotAsync",
      "authority.tools.releaseParallelSlot",
      "inspect.task.getTargetDescriptor",
      "internal.recordEvent",
    ],
  },
  lsp_rename: {
    surface: "skill",
    requiredCapabilities: [
      "authority.tools.acquireParallelSlotAsync",
      "authority.tools.releaseParallelSlot",
      "inspect.task.getTargetDescriptor",
      "internal.recordEvent",
    ],
  },
  lsp_symbols: {
    surface: "skill",
    requiredCapabilities: [
      "authority.tools.acquireParallelSlotAsync",
      "authority.tools.releaseParallelSlot",
      "inspect.task.getTargetDescriptor",
      "internal.recordEvent",
    ],
  },
  output_search: {
    surface: "skill",
    requiredCapabilities: ["inspect.events.list", "internal.recordEvent"],
  },
  workflow_status: {
    surface: "control_plane",
    requiredCapabilities: [
      "inspect.events.query",
      "inspect.session.getOpenToolCalls",
      "inspect.session.getUncleanShutdownDiagnostic",
      "inspect.session.listWorkerResults",
      "inspect.skills.getActiveState",
      "inspect.skills.getLatestFailure",
      "inspect.task.getState",
    ],
  },
  follow_up: {
    surface: "skill",
    requiredCapabilities: [
      "authority.schedule.cancelIntent",
      "authority.schedule.createIntent",
      "inspect.schedule.getProjectionSnapshot",
      "inspect.schedule.listIntents",
    ],
  },
  worker_results_merge: {
    surface: "skill",
    requiredCapabilities: ["inspect.session.mergeWorkerResults"],
  },
  worker_results_apply: {
    surface: "skill",
    requiredCapabilities: ["authority.session.applyMergedWorkerResults"],
  },
  schedule_intent: {
    surface: "skill",
    requiredCapabilities: [
      "inspect.schedule.getProjectionSnapshot",
      "inspect.schedule.listIntents",
      "authority.schedule.createIntent",
      "authority.schedule.updateIntent",
      "authority.schedule.cancelIntent",
    ],
  },
  skill_complete: {
    surface: "control_plane",
    requiredCapabilities: [
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
    ],
  },
  skill_promotion: { surface: "skill" },
  subagent_run: {
    surface: "skill",
    requiredCapabilities: ["internal.appendGuardedSupplementalBlocks"],
  },
  subagent_fanout: {
    surface: "skill",
    requiredCapabilities: ["internal.appendGuardedSupplementalBlocks"],
  },
  subagent_status: { surface: "skill" },
  subagent_cancel: { surface: "skill" },
  task_add_item: {
    surface: "control_plane",
    requiredCapabilities: ["authority.task.addItem"],
  },
  task_record_acceptance: {
    surface: "operator",
    requiredCapabilities: ["authority.task.recordAcceptance"],
  },
  task_record_blocker: {
    surface: "control_plane",
    requiredCapabilities: ["authority.task.recordBlocker"],
  },
  task_resolve_blocker: {
    surface: "control_plane",
    requiredCapabilities: ["authority.task.resolveBlocker"],
  },
  task_set_spec: {
    surface: "control_plane",
    requiredCapabilities: ["authority.task.setSpec"],
  },
  task_update_item: {
    surface: "control_plane",
    requiredCapabilities: ["authority.task.updateItem"],
  },
  cost_view: {
    surface: "operator",
    requiredCapabilities: ["inspect.cost.getSummary"],
  },
  obs_query: {
    surface: "operator",
    requiredCapabilities: ["inspect.events.list", "internal.recordEvent"],
  },
  obs_slo_assert: {
    surface: "operator",
    requiredCapabilities: ["inspect.events.list", "internal.recordEvent"],
  },
  obs_snapshot: {
    surface: "operator",
    requiredCapabilities: [
      "inspect.context.getPressureStatus",
      "inspect.context.getPromptStability",
      "inspect.context.getTransientReduction",
      "inspect.context.getUsage",
      "inspect.cost.getSummary",
      "inspect.events.getTapeStatus",
      "inspect.events.list",
      "inspect.task.getState",
    ],
  },
  optimization_continuity: { surface: "skill" },
  iteration_fact: {
    surface: "skill",
    requiredCapabilities: [
      "authority.events.recordMetricObservation",
      "authority.events.recordGuardResult",
      "inspect.events.listGuardResults",
      "inspect.events.listMetricObservations",
    ],
  },
  rollback_last_patch: {
    surface: "operator",
    requiredCapabilities: ["authority.tools.rollbackLastPatchSet"],
  },
} as const satisfies Record<string, ManagedBrewvaToolMetadataRegistryEntry>;
