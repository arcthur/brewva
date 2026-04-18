import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { buildDefaultBundledBrewvaTools } from "./default-bundle.js";
import type {
  BrewvaBundledToolRuntime,
  BrewvaToolDelegationQuery,
  BrewvaToolOrchestration,
} from "./types.js";

export interface BuildBrewvaToolsOptions {
  runtime: BrewvaBundledToolRuntime;
  orchestration?: BrewvaToolOrchestration;
  delegation?: BrewvaToolDelegationQuery;
  toolNames?: readonly string[];
}

function extendBundledToolRuntime(
  runtime: BrewvaBundledToolRuntime,
  options: Pick<BuildBrewvaToolsOptions, "orchestration" | "delegation">,
): BrewvaBundledToolRuntime {
  return {
    ...runtime,
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
    ...(options.delegation ? { delegation: options.delegation } : {}),
  };
}

export function buildBrewvaTools(options: BuildBrewvaToolsOptions): ToolDefinition[] {
  const runtime = extendBundledToolRuntime(options.runtime, options);
  const tools = buildDefaultBundledBrewvaTools(runtime);

  if (!options.toolNames || options.toolNames.length === 0) {
    return tools;
  }

  const allowed = new Set(options.toolNames);
  return tools.filter((tool) => allowed.has(tool.name));
}

export { createLspTools } from "./lsp.js";
export { createAstGrepTools } from "./ast-grep.js";
export { createBrowserTools } from "./browser.js";
export { createDeliberationMemoryTool } from "./deliberation-memory.js";
export { createNarrativeMemoryTool } from "./narrative-memory.js";
export { createKnowledgeCaptureTool } from "./knowledge-capture.js";
export { createRecallSearchTool, createRecallCurateTool } from "./recall.js";
export { createKnowledgeSearchTool } from "./knowledge-search.js";
export { createPrecedentAuditTool } from "./precedent-audit.js";
export { createPrecedentSweepTool } from "./precedent-sweep.js";
export { createReasoningCheckpointTool } from "./reasoning-checkpoint.js";
export { createReasoningRevertTool } from "./reasoning-revert.js";
export { createResourceLeaseTool } from "./resource-lease.js";
export {
  ALL_REVIEW_LANES,
  ALWAYS_ON_REVIEW_LANES,
  CONDITIONAL_REVIEW_LANES,
  buildReviewLaneDelegationTasks,
  deriveReviewLaneActivationPlan,
  isReviewLaneName,
  materializeReviewLaneOutcomes,
  normalizeReviewLaneName,
  synthesizeReviewEnsemble,
  type ReviewEnsembleSynthesis,
  type ReviewEnsembleSynthesisInput,
  type ReviewEvidenceKey,
  type ReviewEvidenceState,
  type ReviewLaneActivationInput,
  type ReviewLaneActivationPlan,
  type ReviewLaneDelegationPacketInput,
  type ReviewLaneOutcomeSummary,
  type ReviewMergeDecision,
  type ReviewPlanningPosture,
} from "./review-ensemble.js";
export {
  REVIEW_CHANGE_CATEGORIES,
  REVIEW_CHANGED_FILE_CLASSES,
  classifyReviewChangedFiles,
  type ReviewChangeCategory,
  type ReviewChangedFileClass,
} from "./review-classification.js";
export {
  getBrewvaToolRequiredCapabilities,
  getExactBrewvaToolRequiredCapabilities,
  TOOL_REQUIRED_CAPABILITIES_BY_NAME,
} from "./required-capabilities.js";
export {
  attachBrewvaToolExecutionTraits,
  defineBrewvaTool,
  getBrewvaAgentParameters,
  getBrewvaToolMetadata,
  resolveBrewvaToolExecutionTraits,
  validateBrewvaToolRequiredCapabilities,
} from "./utils/tool.js";
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
// A2A tools require an orchestration adapter and are typically registered by channel runtime plugins
// (for example `createChannelA2ARuntimePlugin` in `@brewva/brewva-gateway`), not by the default bundle.
export { createA2ATools } from "./a2a.js";
export { createLookAtTool } from "./look-at.js";
export { createGrepTool } from "./grep.js";
export { createGitStatusTool, createGitDiffTool, createGitLogTool } from "./git-observe.js";
export { createExecTool } from "./exec.js";
export { createProcessTool } from "./process.js";
export { createReadSpansTool } from "./read-spans.js";
export {
  buildReadPathDiscoveryObservationPayload,
  collectObservedPathsFromLocationLines,
  type ReadPathDiscoveryObservationPayload,
} from "./read-path-discovery.js";
export { createCostViewTool, formatCostViewText } from "./cost-view.js";
export { createObsQueryTool } from "./observability/obs-query.js";
export { createObsSloAssertTool } from "./observability/obs-slo-assert.js";
export { createObsSnapshotTool } from "./observability/obs-snapshot.js";
export { createOptimizationContinuityTool } from "./optimization-continuity.js";
export { createLedgerQueryTool } from "./ledger-query.js";
export { createIterationFactTool } from "./iteration-fact.js";
export { createOutputSearchTool } from "./output-search.js";
export { createWorkflowStatusTool } from "./workflow-status.js";
export { createTocTools } from "./toc.js";
export { createTapeTools } from "./tape.js";
export { createSessionCompactTool } from "./session-compact.js";
export { createRollbackLastPatchTool } from "./rollback-last-patch.js";
export { createWorkerResultsMergeTool, createWorkerResultsApplyTool } from "./worker-results.js";
export { createFollowUpTool } from "./follow-up.js";
export { createScheduleIntentTool } from "./schedule-intent.js";
export { createSkillLoadTool } from "./skill-load.js";
export { createSkillCompleteTool } from "./skill-complete.js";
export { createSkillPromotionTool } from "./skill-promotion.js";
export { createSubagentStatusTool, createSubagentCancelTool } from "./subagent-control.js";
export { createSubagentRunTool, createSubagentFanoutTool } from "./subagent-run.js";
export { createTaskLedgerTools } from "./task-ledger.js";
export {
  resolveBrewvaModelSelection,
  type BrewvaModelSelection,
  type BrewvaThinkingLevel,
} from "./model-selection.js";
export { selectBrewvaFallbackModel } from "./model-fallback.js";
export {
  shouldInvokeSemanticRerank,
  type BrewvaSemanticReranker,
  type SemanticRerankerCandidate,
  type SemanticRerankerNarrativeExtractionInput,
  type SemanticRerankerNarrativeExtractionResult,
  type SemanticRerankerRerankInput,
  type SemanticRerankerRerankResult,
} from "./semantic-reranker.js";
export {
  BASE_BREWVA_TOOL_NAMES,
  BREWVA_TOOL_SURFACE_BY_NAME,
  CONTROL_PLANE_BREWVA_TOOL_NAMES,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
  SKILL_BREWVA_TOOL_NAMES,
  getBrewvaToolSurface,
  isManagedBrewvaToolName,
  type BrewvaToolSurface,
} from "./surface.js";
export type {
  A2ABroadcastResult,
  A2ASendResult,
  AdvisorConsultBrief,
  AdvisorConsultConfidence,
  AdvisorConsultKind,
  AdvisorDesignOption,
  AdvisorDesignSubagentOutcomeData,
  AdvisorDiagnoseHypothesis,
  AdvisorDiagnoseSubagentOutcomeData,
  AdvisorInvestigateSubagentOutcomeData,
  AdvisorReviewSubagentOutcomeData,
  AdvisorSubagentOutcomeData,
  BrewvaToolOrchestration,
  BrewvaManagedToolDefinition,
  DelegationOutcomeChange,
  DelegationOutcomeCheck,
  DelegationOutcomeFinding,
  DelegationCompletionPredicate,
  DelegationPacket,
  DelegationRef,
  DelegationRefKind,
  DelegationTaskPacket,
  PlanExecutionStep,
  PlanImplementationTarget,
  PlanRiskItem,
  PatchSubagentOutcomeData,
  QaCheck,
  QaSubagentOutcomeData,
  ReviewLaneConfidence,
  ReviewLaneDisposition,
  ReviewLaneName,
  SubagentExecutionShape,
  SubagentContextBudget,
  SubagentContextRef,
  SubagentContextRefKind,
  SubagentDelegationMode,
  SubagentExecutionBoundary,
  SubagentExecutionHints,
  SubagentOutcomeArtifactRef,
  SubagentOutcomeData,
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
  BrewvaToolDelegationQuery,
  BrewvaBundledToolOptions,
  BrewvaBundledToolRuntime,
  BrewvaToolExecutionTraitResolverInput,
  BrewvaToolExecutionTraits,
  BrewvaToolExecutionTraitsResolver,
  BrewvaToolInterruptBehavior,
  BrewvaToolMetadata,
  BrewvaToolRequiredCapability,
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
