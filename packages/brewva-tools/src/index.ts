import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createAstGrepTools } from "./ast-grep.js";
import { createBrowserTools } from "./browser.js";
import { createCostViewTool } from "./cost-view.js";
import { createExecTool } from "./exec.js";
import { createGrepTool } from "./grep.js";
import { createLedgerQueryTool } from "./ledger-query.js";
import { createLookAtTool } from "./look-at.js";
import { createLspTools } from "./lsp.js";
import { createObsQueryTool } from "./observability/obs-query.js";
import { createObsSloAssertTool } from "./observability/obs-slo-assert.js";
import { createObsSnapshotTool } from "./observability/obs-snapshot.js";
import { createOutputSearchTool } from "./output-search.js";
import { createProcessTool } from "./process.js";
import { createReadSpansTool } from "./read-spans.js";
import { createResourceLeaseTool } from "./resource-lease.js";
import { createRollbackLastPatchTool } from "./rollback-last-patch.js";
import { createScheduleIntentTool } from "./schedule-intent.js";
import { createSessionCompactTool } from "./session-compact.js";
import { createSkillCompleteTool } from "./skill-complete.js";
import { createSkillLoadTool } from "./skill-load.js";
import { createSubagentCancelTool, createSubagentStatusTool } from "./subagent-control.js";
import { createSubagentFanoutTool, createSubagentRunTool } from "./subagent-run.js";
import { createTapeTools } from "./tape.js";
import { createTaskLedgerTools } from "./task-ledger.js";
import { createTocTools } from "./toc.js";
import type { BrewvaToolOrchestration, BrewvaToolRuntime } from "./types.js";
import { createWorkerResultsApplyTool, createWorkerResultsMergeTool } from "./worker-results.js";
import { createWorkflowStatusTool } from "./workflow-status.js";

export interface BuildBrewvaToolsOptions {
  runtime: BrewvaToolRuntime;
  orchestration?: BrewvaToolOrchestration;
  toolNames?: readonly string[];
}

export function buildBrewvaTools(options: BuildBrewvaToolsOptions): ToolDefinition[] {
  const runtime = Object.assign(
    {},
    options.runtime,
    options.orchestration ? { orchestration: options.orchestration } : {},
  ) as BrewvaToolRuntime;

  const tools = [
    ...createLspTools({ runtime }),
    ...createTocTools({ runtime }),
    ...createAstGrepTools(),
    createReadSpansTool({ runtime }),
    createLookAtTool(),
    createGrepTool({ runtime }),
    createExecTool({ runtime }),
    ...createBrowserTools({ runtime }),
    createProcessTool(),
    createCostViewTool({ runtime }),
    createObsQueryTool({ runtime }),
    createObsSloAssertTool({ runtime }),
    createObsSnapshotTool({ runtime }),
    createLedgerQueryTool({ runtime }),
    createOutputSearchTool({ runtime }),
    createWorkflowStatusTool({ runtime }),
    createScheduleIntentTool({ runtime }),
    ...createTapeTools({ runtime }),
    createSessionCompactTool({ runtime }),
    createResourceLeaseTool({ runtime }),
    createRollbackLastPatchTool({ runtime }),
    createWorkerResultsMergeTool({ runtime }),
    createWorkerResultsApplyTool({ runtime }),
    createSkillLoadTool({ runtime }),
    createSkillCompleteTool({ runtime }),
    createSubagentRunTool({ runtime }),
    createSubagentFanoutTool({ runtime }),
    createSubagentStatusTool({ runtime }),
    createSubagentCancelTool({ runtime }),
    ...createTaskLedgerTools({ runtime }),
  ];

  if (!options.toolNames || options.toolNames.length === 0) {
    return tools;
  }

  const allowed = new Set(options.toolNames);
  return tools.filter((tool) => allowed.has(tool.name));
}

export { createLspTools } from "./lsp.js";
export { createAstGrepTools } from "./ast-grep.js";
export { createBrowserTools } from "./browser.js";
export { createResourceLeaseTool } from "./resource-lease.js";
export { defineBrewvaTool, getBrewvaAgentParameters, getBrewvaToolMetadata } from "./utils/tool.js";
export {
  BREWVA_STRING_ENUM_CONTRACT,
  BREWVA_STRING_ENUM_CONTRACT_PATHS,
  attachStringEnumContractPaths,
  collectStringEnumContractMismatches,
  collectStringEnumContracts,
  lowerStringEnumContractParameters,
  lowerStringEnumContractValue,
  normalizeStringEnumContractValue,
  readStringEnumContractPathMetadata,
  readStringEnumContractMetadata,
  type StringEnumContractEntry,
  type StringEnumContractPathMetadataEntry,
  type StringEnumContractMetadata,
  type StringEnumContractMismatch,
} from "./utils/input-alias.js";
// A2A tools require an orchestration adapter and are typically registered by channel extensions
// (for example `createChannelA2AExtension` in `@brewva/brewva-gateway`), not by the default bundle.
export { createA2ATools } from "./a2a.js";
export { createLookAtTool } from "./look-at.js";
export { createGrepTool } from "./grep.js";
export { createExecTool } from "./exec.js";
export { createProcessTool } from "./process.js";
export { createReadSpansTool } from "./read-spans.js";
export { createCostViewTool } from "./cost-view.js";
export { createObsQueryTool } from "./observability/obs-query.js";
export { createObsSloAssertTool } from "./observability/obs-slo-assert.js";
export { createObsSnapshotTool } from "./observability/obs-snapshot.js";
export { createLedgerQueryTool } from "./ledger-query.js";
export { createOutputSearchTool } from "./output-search.js";
export { createWorkflowStatusTool } from "./workflow-status.js";
export { createTocTools } from "./toc.js";
export { createTapeTools } from "./tape.js";
export { createSessionCompactTool } from "./session-compact.js";
export { createRollbackLastPatchTool } from "./rollback-last-patch.js";
export { createWorkerResultsMergeTool, createWorkerResultsApplyTool } from "./worker-results.js";
export { createScheduleIntentTool } from "./schedule-intent.js";
export { createSkillLoadTool } from "./skill-load.js";
export { createSkillCompleteTool } from "./skill-complete.js";
export { createSubagentStatusTool, createSubagentCancelTool } from "./subagent-control.js";
export { createSubagentRunTool, createSubagentFanoutTool } from "./subagent-run.js";
export { createTaskLedgerTools } from "./task-ledger.js";
export {
  resolveBrewvaModelSelection,
  type BrewvaModelSelection,
  type BrewvaThinkingLevel,
} from "./model-selection.js";
export {
  BASE_BREWVA_TOOL_NAMES,
  BREWVA_TOOL_SURFACE_BY_NAME,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
  SKILL_BREWVA_TOOL_NAMES,
  getBrewvaToolSurface,
  isManagedBrewvaToolName,
  type BrewvaToolSurface,
} from "./surface.js";
export type {
  BrewvaToolOrchestration,
  BrewvaManagedToolDefinition,
  DelegationPacket,
  DelegationTaskPacket,
  SubagentContextBudget,
  SubagentContextRef,
  SubagentContextRefKind,
  SubagentDelegationMode,
  SubagentExecutionBoundary,
  SubagentExecutionHints,
  SubagentOutcomeArtifactRef,
  SubagentOutcome,
  SubagentOutcomeBase,
  SubagentOutcomeEvidenceRef,
  SubagentOutcomeFailure,
  SubagentOutcomeMetricSummary,
  SubagentOutcomeSuccess,
  SubagentReturnMode,
  SubagentResultMode,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentStartResult,
  SubagentStatusResult,
  SubagentCancelResult,
  BrewvaToolMetadata,
  BrewvaToolRuntime,
} from "./types.js";
export {
  getToolSessionId,
  readTextBatch,
  recordParallelReadTelemetry,
  resolveAdaptiveBatchSize,
  resolveParallelReadConfig,
  summarizeReadBatch,
  withParallelReadSlot,
} from "./utils/parallel-read.js";
