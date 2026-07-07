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

  // tool_chain dispatches sibling read-only tools by name. Give it a late-bound
  // resolver over the just-built siblings — this is the only site with
  // visibility into all tool definitions. The map is built before tool_chain is
  // added, so a chain can never resolve (or nest) itself.
  const siblingsByName = new Map(tools.map((tool) => [tool.name, tool] as const));
  tools.push(
    createToolChainTool({
      runtime,
      resolveSibling: (name) => siblingsByName.get(name),
    }),
  );

  for (const tool of tools) {
    validateBrewvaToolRequiredCapabilities(tool);
  }

  return tools;
}
