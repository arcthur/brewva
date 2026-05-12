export {
  COMPACTION_RECOVERY_TEST_ONLY,
  COMPACTION_RESUME_PROMPT,
  applyPromptRecoveryPolicy,
  dispatchPromptWithCompactionSettlement,
  getCompactionGenerationState,
  installSessionCompactionRecovery,
  type CompactionRecoveryOptions,
  type CompactionRecoverySessionLike,
  type PromptRecoveryPolicyApplicationResult,
} from "./internal/compaction/recovery.js";
export {
  DETERMINISTIC_EMERGENCY_COMPACTION_STRATEGY,
  LLM_PRIMARY_COMPACTION_STRATEGY,
  createHostedLlmCompactionSummaryGenerator,
  normalizeCompactionSummaryForStorage,
  type BrewvaCompactionSummaryGenerationInput,
  type BrewvaCompactionSummaryGenerationResult,
  type BrewvaCompactionSummaryGenerator,
  type BrewvaCompactionSummaryStrategy,
  type HostedLlmCompactionSummaryGeneratorOptions,
} from "./internal/compaction/summary-generator.js";
