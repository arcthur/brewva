import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { createAstGrepTools } from "./ast-grep.js";
import { createBrowserTools } from "./browser.js";
import { createCostViewTool } from "./cost-view.js";
import { createDeliberationMemoryTool } from "./deliberation-memory.js";
import { createExecTool } from "./exec.js";
import { createFollowUpTool } from "./follow-up.js";
import { createGitDiffTool, createGitLogTool, createGitStatusTool } from "./git-observe.js";
import { createGrepTool } from "./grep.js";
import { createIterationFactTool } from "./iteration-fact.js";
import { createKnowledgeCaptureTool } from "./knowledge-capture.js";
import { createKnowledgeSearchTool } from "./knowledge-search.js";
import { createLedgerQueryTool } from "./ledger-query.js";
import { createLookAtTool } from "./look-at.js";
import { createLspTools } from "./lsp.js";
import { createNarrativeMemoryTool } from "./narrative-memory.js";
import { createObsQueryTool } from "./observability/obs-query.js";
import { createObsSloAssertTool } from "./observability/obs-slo-assert.js";
import { createObsSnapshotTool } from "./observability/obs-snapshot.js";
import { createOptimizationContinuityTool } from "./optimization-continuity.js";
import { createOutputSearchTool } from "./output-search.js";
import { createPrecedentAuditTool } from "./precedent-audit.js";
import { createPrecedentSweepTool } from "./precedent-sweep.js";
import { createProcessTool } from "./process.js";
import { createQuestionTool } from "./question.js";
import { createReadSpansTool } from "./read-spans.js";
import { createReasoningCheckpointTool } from "./reasoning-checkpoint.js";
import { createReasoningRevertTool } from "./reasoning-revert.js";
import { createRecallCurateTool, createRecallSearchTool } from "./recall.js";
import { createResourceLeaseTool } from "./resource-lease.js";
import { createRollbackLastPatchTool } from "./rollback-last-patch.js";
import { createScheduleIntentTool } from "./schedule-intent.js";
import { createSessionCompactTool } from "./session-compact.js";
import { createSkillCompleteTool } from "./skill-complete.js";
import { createSkillLoadTool } from "./skill-load.js";
import {
  createSkillPromotionInspectTool,
  createSkillPromotionPromoteTool,
  createSkillPromotionReviewTool,
} from "./skill-promotion.js";
import { createSubagentCancelTool, createSubagentStatusTool } from "./subagent-control.js";
import { createSubagentFanoutTool, createSubagentRunTool } from "./subagent-run.js";
import { createTapeTools } from "./tape.js";
import { createTaskLedgerTools } from "./task-ledger.js";
import { createTocTools } from "./toc.js";
import type { BrewvaBundledToolRuntime } from "./types.js";
import { validateBrewvaToolRequiredCapabilities } from "./utils/tool.js";
import { createWorkerResultsApplyTool, createWorkerResultsMergeTool } from "./worker-results.js";
import { createWorkflowStatusTool } from "./workflow-status.js";

export function buildDefaultBundledBrewvaTools(
  runtime: BrewvaBundledToolRuntime,
): ToolDefinition[] {
  const tools = [
    ...createLspTools({ runtime }),
    ...createTocTools({ runtime }),
    ...createAstGrepTools(),
    createReadSpansTool({ runtime }),
    createLookAtTool({ runtime }),
    createGrepTool({ runtime }),
    createGitStatusTool({ runtime }),
    createGitDiffTool({ runtime }),
    createGitLogTool({ runtime }),
    createExecTool({ runtime }),
    ...createBrowserTools({ runtime }),
    createProcessTool({ runtime }),
    createQuestionTool(),
    createCostViewTool({ runtime }),
    createDeliberationMemoryTool({ runtime }),
    createNarrativeMemoryTool({ runtime }),
    createKnowledgeCaptureTool({ runtime }),
    createRecallSearchTool({ runtime }),
    createRecallCurateTool({ runtime }),
    createKnowledgeSearchTool({ runtime }),
    createPrecedentAuditTool({ runtime }),
    createPrecedentSweepTool({ runtime }),
    createObsQueryTool({ runtime }),
    createObsSloAssertTool({ runtime }),
    createObsSnapshotTool({ runtime }),
    createOptimizationContinuityTool({ runtime }),
    createLedgerQueryTool({ runtime }),
    createIterationFactTool({ runtime }),
    createOutputSearchTool({ runtime }),
    createWorkflowStatusTool({ runtime }),
    createFollowUpTool({ runtime }),
    createScheduleIntentTool({ runtime }),
    ...createTapeTools({ runtime }),
    createReasoningCheckpointTool({ runtime }),
    createReasoningRevertTool({ runtime }),
    createSessionCompactTool({ runtime }),
    createResourceLeaseTool({ runtime }),
    createRollbackLastPatchTool({ runtime }),
    createWorkerResultsMergeTool({ runtime }),
    createWorkerResultsApplyTool({ runtime }),
    createSkillLoadTool({ runtime }),
    createSkillCompleteTool({ runtime }),
    createSkillPromotionInspectTool({ runtime }),
    createSkillPromotionReviewTool({ runtime }),
    createSkillPromotionPromoteTool({ runtime }),
    createSubagentRunTool({ runtime }),
    createSubagentFanoutTool({ runtime }),
    createSubagentStatusTool({ runtime }),
    createSubagentCancelTool({ runtime }),
    ...createTaskLedgerTools({ runtime }),
  ];

  for (const tool of tools) {
    validateBrewvaToolRequiredCapabilities(tool);
  }

  return tools;
}
