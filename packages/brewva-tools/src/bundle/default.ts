import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type { BrewvaBundledToolRuntime } from "../contracts/index.js";
import {
  createDelegationInboxQueryTool,
  createQuestionTool,
  createSubagentCancelTool,
  createSubagentFanoutTool,
  createSubagentForkTool,
  createSubagentKnowledgeAdoptTool,
  createSubagentRunDiagnosticTool,
  createSubagentRunTool,
  createSubagentStatusTool,
} from "../families/delegation/api.js";
import { createExecTool, createProcessTool } from "../families/execution/api.js";
import {
  createKnowledgeCaptureTool,
  createKnowledgeSearchTool,
  createPrecedentAuditTool,
  createPrecedentSweepTool,
  createRecallCurateTool,
  createRecallSearchTool,
  createWorkbenchEvictTool,
  createWorkbenchNoteTool,
  createWorkbenchUndoEvictTool,
} from "../families/memory/api.js";
import {
  createBrowserTools,
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
    createDiscoverSkillsTool({ runtime }),
    createGitStatusTool({ runtime }),
    createGitDiffTool({ runtime }),
    createGitLogTool({ runtime }),
    createExecTool({ runtime }),
    ...createBrowserTools({ runtime }),
    createProcessTool({ runtime }),
    createQuestionTool(),
    createCostViewTool({ runtime }),
    createWorkbenchNoteTool({ runtime }),
    createWorkbenchEvictTool({ runtime }),
    createWorkbenchUndoEvictTool({ runtime }),
    createKnowledgeCaptureTool({ runtime }),
    createRecallSearchTool({ runtime }),
    createRecallCurateTool({ runtime }),
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
    createScheduleIntentTool({ runtime }),
    ...createTapeTools({ runtime }),
    createReasoningCheckpointTool({ runtime }),
    createReasoningRevertTool({ runtime }),
    createWorkbenchCompactTool({ runtime }),
    createResourceLeaseTool({ runtime }),
    createRollbackLastPatchTool({ runtime }),
    createWorkerResultsMergeTool({ runtime }),
    createWorkerResultsApplyTool({ runtime }),
    createWorkerResultsRejectTool({ runtime }),
    createSubagentRunTool({ runtime }),
    createSubagentFanoutTool({ runtime }),
    createSubagentForkTool({ runtime }),
    createSubagentKnowledgeAdoptTool({ runtime }),
    createDelegationInboxQueryTool({ runtime }),
    createSubagentRunDiagnosticTool({ runtime }),
    createSubagentStatusTool({ runtime }),
    createSubagentCancelTool({ runtime }),
    ...createTaskLedgerTools({ runtime }),
  ];

  for (const tool of tools) {
    validateBrewvaToolRequiredCapabilities(tool);
  }

  return tools;
}
