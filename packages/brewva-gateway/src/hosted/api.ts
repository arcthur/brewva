export type { CreateHostedSessionOptions, HostedSession, HostedSessionResult } from "./session.js";
export {
  createHostedModelCatalog,
  createHostedSession,
  resolvePresetRoleModel,
  selectNextModelPresetName,
} from "./session.js";
export type {
  HostedPromptTurnResult,
  HostedTurnEnvelopeResult,
  SubscribablePromptSession,
} from "./turn-adapter.js";
export {
  resolveSubagentSessionShutdownReason,
  resolveWorkerSessionShutdownReceipt,
  runHostedPromptTurn,
  runHostedTurnEnvelope,
} from "./turn-adapter.js";
export { createHostedRuntimeAdapter } from "./internal/session/runtime-ports.js";
export { drainShadowDivergenceEvidence } from "./internal/turn/shadow-divergence-drain.js";
export { enqueueGoalContinuation } from "../utils/goal-continuation.js";
export type { EnqueueGoalContinuationInput } from "../utils/goal-continuation.js";
export { recordRuntimeGoalContinuationQueued } from "./internal/session/projection/runtime-write-adapters.js";
export {
  createHostedHarnessRuntimeExecutionPorts,
  type HostedHarnessRuntimeExecutionPorts,
} from "./internal/turn/runtime-turn-execution-ports.js";
export {
  acquireRuntimeParallelSlot,
  adoptRuntimeLineageOutcome,
  createRuntimeLineageNode,
  getRuntimeClaimState,
  getRuntimeCostPosture,
  getRuntimeCostSummary,
  getRuntimeOpsPort,
  getRuntimeSessionLineageContextEntryPath,
  getRuntimeSessionLineageNode,
  getRuntimeSessionLineageTree,
  getRuntimeSkillCatalogEntry,
  getRuntimeTapeStatus,
  getRuntimeTaskState,
  getRuntimeToolActionPolicy,
  listRuntimeEventSessionIds,
  listRuntimeEvents,
  listRuntimePendingProposalRequests,
  listRuntimeProposalRequests,
  listRuntimeWorkerResults,
  queryRuntimeEvents,
  queryStructuredRuntimeEvents,
  recordRuntimeAssistantCost,
  recordRuntimeLineageOutcome,
  recordRuntimeScheduleChildFailed,
  recordRuntimeScheduleChildFinished,
  recordRuntimeScheduleChildStarted,
  recordRuntimeScheduleWakeup,
  recordRuntimeSkillSelection,
  recordRuntimeToolCapabilitySelection,
  recordRuntimeToolSurfaceResolved,
  recordRuntimeWorkbenchNote,
  recordRuntimeWorkerResult,
  releaseRuntimeParallelSlot,
  setRuntimeTaskSpec,
  subscribeRuntimeEvents,
  toStructuredRuntimeEvent,
} from "./internal/session/runtime-ports.js";
export type {
  HostedRuntimeAdapterPort,
  BrewvaRuntimeOptions,
  HostedRuntimeAdapterOptions,
  RuntimeAdapterCapabilitiesPort,
  RuntimeAdapterOpsPort,
  ToolRuntimeAdapterPort,
} from "./internal/session/runtime-ports.js";
export type {
  ProviderApiKeyAuthMethod,
  ProviderAuthHandler,
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderConnectionDescriptor,
  ProviderConnectionGroup,
  ProviderConnectionSource,
  ProviderConnectionSeams,
  ProviderOAuthAuthMethod,
  ProviderOAuthAuthorization,
  ProviderOAuthCompletion,
} from "./provider.js";
export {
  configureCredentialVaultModelAuth,
  createProviderConnectionPort,
  createProviderConnectionSeams,
  getProviderCredentialRef,
} from "./provider.js";
export {
  buildContextEvidenceReport,
  buildDelegationEvidenceReport,
  deriveContextEvidenceRecommendation,
  persistContextEvidenceReport,
  type ContextEvidenceAggregateReport,
  type ContextEvidenceRecommendation,
  type ContextEvidenceRecommendationInput,
  type DelegationEvidenceAggregate,
  type DelegationEvidenceReport,
  type DelegationEvidenceReportOptions,
  type DelegationEvidenceSessionReport,
} from "./context.js";
