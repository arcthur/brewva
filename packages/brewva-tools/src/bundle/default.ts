import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type { BrewvaBundledToolRuntime } from "../contracts/index.js";
import {
  createDelegationInboxQueryTool,
  createQuestionTool,
  createSubagentCancelTool,
  createSubagentFanoutTool,
  createSubagentForkTool,
  createReviewRequestTool,
  createSubagentKnowledgeAdoptTool,
  createSubagentRunDiagnosticTool,
  createSubagentRunTool,
  createSubagentStatusTool,
} from "../families/delegation/api.js";
import {
  createExecTool,
  createProcessTool,
  createToolChainTool,
} from "../families/execution/api.js";
import {
  createAttentionOptionTools,
  createContextRouteTool,
  createKnowledgeCaptureTool,
  createKnowledgeSearchTool,
  createPrecedentAuditTool,
  createPrecedentSweepTool,
  createRecallCurateTool,
  createRecallExpandTool,
  createRecallSearchTool,
  createUserFactTool,
  createUserModelTool,
  createWorkbenchEvictTool,
  createWorkbenchNoteTool,
  createWorkbenchUndoEvictTool,
} from "../families/memory/api.js";
import {
  createBrowserTools,
  createGlobTool,
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
  createGrepTool,
  createLookAtTool,
  createLspTools,
  createOutputSearchTool,
  createResourceReadTool,
  createSourcePatchTools,
  createSourceReadTool,
  createSourceIntelligenceTools,
} from "../families/navigation/api.js";
import { createDiscoverSkillsTool } from "../families/skills/api.js";
import {
  createCostViewTool,
  createFollowUpTool,
  createGoalTools,
  createIterationFactTool,
  createLedgerQueryTool,
  createObsQueryTool,
  createObsSloAssertTool,
  createObsSnapshotTool,
  createReasoningCheckpointTool,
  createReasoningRevertTool,
  createResourceLeaseTool,
  createRollbackLastPatchTool,
  createScheduleIntentTool,
  createVerificationRecordTool,
  createWorkbenchCompactTool,
  createTapeTools,
  createTaskLedgerTools,
  createWorkerResultsApplyTool,
  createWorkerResultsMergeTool,
  createWorkerResultsRejectTool,
  createWorkflowStatusTool,
} from "../families/workflow/api.js";
import { validateBrewvaToolRequiredCapabilities } from "../registry/tool.js";

export function buildDefaultBundledBrewvaTools(
  runtime: BrewvaBundledToolRuntime,
  options: { readonly toolNames?: readonly string[] } = {},
): ToolDefinition[] {
  const tools = [
    ...createLspTools({ runtime }),
    ...createSourceIntelligenceTools({ runtime }),
    createSourceReadTool({ runtime }),
    ...createSourcePatchTools({ runtime }),
    createResourceReadTool({ runtime }),
    createLookAtTool({ runtime }),
    createGrepTool({ runtime }),
    createGlobTool({ runtime }),
    createDiscoverSkillsTool({ runtime }),
    createGitStatusTool({ runtime }),
    createGitDiffTool({ runtime }),
    createGitLogTool({ runtime }),
    createExecTool({ runtime }),
    ...createBrowserTools({ runtime }),
    createProcessTool({ runtime }),
    createQuestionTool(),
    ...createAttentionOptionTools({ runtime }),
    createCostViewTool({ runtime }),
    createWorkbenchNoteTool({ runtime }),
    createWorkbenchEvictTool({ runtime }),
    createWorkbenchUndoEvictTool({ runtime }),
    createUserFactTool({ runtime }),
    createUserModelTool({ runtime }),
    createKnowledgeCaptureTool({ runtime }),
    createRecallSearchTool({ runtime }),
    createRecallCurateTool({ runtime }),
    createRecallExpandTool({ runtime }),
    createContextRouteTool({ runtime }),
    createKnowledgeSearchTool({ runtime }),
    createPrecedentAuditTool({ runtime }),
    createPrecedentSweepTool({ runtime }),
    createObsQueryTool({ runtime }),
    createObsSloAssertTool({ runtime }),
    createObsSnapshotTool({ runtime }),
    createLedgerQueryTool({ runtime }),
    createIterationFactTool({ runtime }),
    createOutputSearchTool({ runtime }),
    createWorkflowStatusTool({ runtime }),
    createFollowUpTool({ runtime }),
    ...createGoalTools({ runtime }),
    createScheduleIntentTool({ runtime }),
    ...createTapeTools({ runtime }),
    createReasoningCheckpointTool({ runtime }),
    createReasoningRevertTool({ runtime }),
    createVerificationRecordTool({ runtime }),
    createWorkbenchCompactTool({ runtime }),
    createResourceLeaseTool({ runtime }),
    createRollbackLastPatchTool({ runtime }),
    createWorkerResultsMergeTool({ runtime }),
    createWorkerResultsApplyTool({ runtime }),
    createWorkerResultsRejectTool({ runtime }),
    createSubagentRunTool({ runtime }),
    createReviewRequestTool({ runtime }),
    createSubagentFanoutTool({ runtime }),
    createSubagentForkTool({ runtime }),
    createSubagentKnowledgeAdoptTool({ runtime }),
    createDelegationInboxQueryTool({ runtime }),
    createSubagentRunDiagnosticTool({ runtime }),
    createSubagentStatusTool({ runtime }),
    createSubagentCancelTool({ runtime }),
    ...createTaskLedgerTools({ runtime }),
  ];

  // Filter to the operator-selected surface (`managedToolNames`) BEFORE wiring
  // tool_chain's sibling resolver, so a chain can never dispatch a bundle tool
  // that was removed from the model's own surface (capability-scope parity).
  const allowed =
    options.toolNames && options.toolNames.length > 0 ? new Set(options.toolNames) : null;
  const visibleTools = allowed ? tools.filter((tool) => allowed.has(tool.name)) : tools;

  // tool_chain dispatches sibling read-only tools by name. Give it a resolver
  // over the VISIBLE bundle siblings, built before tool_chain is added — so a
  // chain can never resolve (or nest) itself, nor a tool hidden from this
  // session. Read/edit/write/custom/MCP live on `runtime.toolSiblingResolver`,
  // which the tool consults as a fallback (populated by the gateway).
  const siblingsByName = new Map(visibleTools.map((tool) => [tool.name, tool] as const));
  const toolChain = createToolChainTool({
    runtime,
    resolveSibling: (name) => siblingsByName.get(name),
  });

  const result = [...visibleTools];
  if (!allowed || allowed.has("tool_chain")) {
    result.push(toolChain);
  }

  // Validate the whole bundle (+ tool_chain) so a required-capability bug is
  // caught even for a tool filtered out of this particular session.
  for (const tool of tools) {
    validateBrewvaToolRequiredCapabilities(tool);
  }
  validateBrewvaToolRequiredCapabilities(toolChain);

  return result;
}
