import { ContextBudgetManager as InternalContextBudgetManager } from "./domain/context/api.js";
import { createBoundExtensionPort, type ExtensionPort } from "./runtime/runtime-extensions.js";

const CONTEXT_BUDGET_MANAGER_METHODS = [
  "beginTurn",
  "observeUsage",
  "getEffectivePolicy",
  "getEffectiveCompactionThresholdPercent",
  "getEffectiveHardLimitPercent",
  "getEffectiveDynamicTailTokenBudget",
  "planDynamicTailAdmission",
  "shouldRequestCompaction",
  "markCompacted",
  "requestCompaction",
  "getPendingCompactionReason",
  "getLastContextUsage",
  "getLastCompactionTurn",
  "clear",
  "getCompactionInstructions",
] as const satisfies readonly (keyof InstanceType<typeof InternalContextBudgetManager>)[];
export type ContextBudgetManager = ExtensionPort<
  "context.budget-manager",
  Pick<
    InstanceType<typeof InternalContextBudgetManager>,
    (typeof CONTEXT_BUDGET_MANAGER_METHODS)[number]
  >
>;

export function createContextBudgetManager(
  ...args: ConstructorParameters<typeof InternalContextBudgetManager>
): ContextBudgetManager {
  return createBoundExtensionPort({
    name: "context.budget-manager",
    instance: new InternalContextBudgetManager(...args),
    methods: CONTEXT_BUDGET_MANAGER_METHODS,
  });
}

// BEGIN curated boundary exports
export type {
  ContextBudgetUsage,
  ContextCompactionDecision,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextEvidenceKind,
  ContextEvidenceSample,
  ContextStatus,
  ExpectedProviderCacheBreak,
  HistoryViewBaselineOrigin,
  HistoryViewBaselineSnapshot,
  OutputSearchTelemetryState,
  ParallelAcquireResult,
  PromptStabilityObservationInput,
  PromptStabilityState,
  ProviderCacheBreakClassification,
  ProviderCacheBreakObservation,
  ProviderCacheCapabilityState,
  ProviderCacheCapabilityStrategy,
  ProviderCacheFingerprintState,
  ProviderCacheObservationInput,
  ProviderCacheObservationState,
  ProviderCacheRenderState,
  ProviderSessionContinuationCapabilityState,
  RecoveryPendingFamily,
  RecoveryPostureMode,
  RecoveryPostureSnapshot,
  RecoveryWorkingSetSnapshot,
  ResourceLeaseBudget,
  ResourceLeaseCancelResult,
  ResourceLeaseQuery,
  ResourceLeaseRecord,
  ResourceLeaseRequest,
  ResourceLeaseResult,
  SessionCompactionCommitInput,
  SessionCompactionCacheImpact,
  SessionCompactionCacheImpactSnapshot,
  SessionCompactionGenerationMetadata,
  SessionCompactionOrigin,
  TapeAnchorState,
  TapeHandoffResult,
  TapePressureLevel,
  TapeSearchMatch,
  TapeSearchResult,
  TapeSearchScope,
  TapeStatusState,
  ToolAccessResult,
  TransientReductionObservationInput,
  TransientReductionState,
  VisibleReadState,
} from "./domain/context/types.js";
export {
  normalizeAgentId,
  readAgentConstitutionProfile,
  readAgentMemoryProfile,
  readPersonaProfile,
} from "./domain/context/identity.js";
export type {
  AgentConstitutionProfile,
  AgentMemoryProfile,
  PersonaProfile,
  ReadPersonaProfileInput,
} from "./domain/context/identity.js";
export { coerceContextBudgetUsage } from "./domain/context/usage.js";
// END curated boundary exports
