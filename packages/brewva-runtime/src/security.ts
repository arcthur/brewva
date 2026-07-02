import {
  CredentialVaultService as InternalCredentialVaultService,
  createCredentialVaultServiceFromSecurityConfig as createInternalCredentialVaultServiceFromSecurityConfig,
} from "./credentials/credential-vault.js";

export {
  getSourceTrustTier,
  sanitizeByTrust,
  sanitizeContextText,
  wrapByTrust,
} from "./security/sanitize.js";
export type { SourceTrustTier } from "./security/sanitize.js";
export {
  sanitizeCompactionSummary,
  validateCompactionSummary,
} from "./security/compaction-integrity.js";
export type { CompactionIntegrityResult } from "./security/compaction-integrity.js";
export {
  analyzeShellCommand,
  collectCommandPolicyNetworkTargets,
  summarizeShellCommandAnalysis,
} from "./security/command-policy.js";
export type {
  CommandPolicyCommand,
  CommandPolicyEffect,
  CommandPolicyNetworkTarget,
  CommandPolicySummary,
  CommandPolicyUnsupportedReason,
  FilesystemIntent,
  ShellCommandAnalysis,
} from "./security/command-policy.js";
export {
  analyzeVirtualReadonlyEligibility,
  summarizeVirtualReadonlyEligibility,
} from "./security/virtual-readonly-policy.js";
export {
  classifyObservationShape,
  createObservationShapeShadowResolver,
  OBSERVATION_SHAPE_SHADOW_INTERCEPTOR_ID,
} from "./runtime/kernel/policy/observation-shape-shadow.js";
export type {
  VirtualReadonlyBlockedReason,
  VirtualReadonlyEligibility,
  VirtualReadonlyPolicySummary,
} from "./security/virtual-readonly-policy.js";
export {
  classifyToolBoundaryRequest,
  collectExplicitUrlTargets,
  evaluateBoundaryClassification,
  resolveBoundaryPolicy,
} from "./security/boundary-policy.js";
export type {
  ResolvedBoundaryPolicy,
  ToolBoundaryClassification,
} from "./security/boundary-policy.js";
export { CONTEXT_CRITICAL_ALLOWED_TOOLS } from "./security/control-plane-tools.js";
export { checkToolAccess } from "./security/tool-policy.js";
export type { ToolPolicyOptions } from "./security/tool-policy.js";
export {
  projectOperatorSafetyDecision,
  renderOperatorSafetyDecision,
  renderOperatorSafetyRecoveryHint,
} from "./read-models/projection/operator-safety.js";
export type {
  DenialReason,
  DenialReasonCategory,
  OperatorSafetyCapabilityBasis,
  OperatorSafetyDecision,
  OperatorSafetyDecisionView,
  OperatorSafetyRetryHint,
  ProjectOperatorSafetyDecisionInput,
  SandboxPosture,
} from "./read-models/projection/operator-safety.js";
export {
  ActionPolicyRegistry,
  TOOL_ACTION_CLASSES,
  TOOL_ACTION_POLICY_BY_NAME,
  TOOL_ADMISSION_BEHAVIORS,
  compareToolAdmission,
  createActionPolicyRegistry,
  deriveEffectCommitmentPosture,
  deriveToolGovernanceDescriptor,
  getExactToolActionPolicy,
  getToolActionClassAdmissionBounds,
  getToolActionPolicy,
  getToolActionPolicyForClass,
  getToolActionPolicyResolution,
  getToolGovernanceDescriptor,
  getToolGovernanceResolution,
  resolveEffectiveToolActionPolicy,
  resolveRecoveryPreparationFromPolicy,
  resolveToolAuthority,
  resolveToolExecutionBoundary,
  resolveToolExecutionBoundaryFromEffects,
  resolveToolRecoveryPreparation,
  sameToolActionPolicy,
  toolActionPolicyRequiresApproval,
  toolEffectsRequireEffectCommitment,
  toolGovernanceRequiresEffectCommitment,
  validateToolActionPolicy,
} from "./runtime/kernel/policy/public-contract.js";
export type {
  DeriveEffectCommitmentPostureInput,
  EffectAuthorityManifestBasis,
  EffectCommitmentExecutionEvidence,
  EffectCommitmentPosture,
  EffectPostureEvidenceSource,
  EffectPostureWarning,
  EffectPostureWarningCode,
  EffectProjectionWarning,
  EffectRecoverability,
  EffectVisibility,
  EffectiveToolActionPolicy,
  MutationReceipt,
  MutationSubject,
  PatchSetRedoFailureReason,
  PatchSetRollbackFailureReason,
  ResolvedToolAuthority,
  ToolActionAdmissionOverrides,
  ToolActionClass,
  ToolActionPolicy,
  ToolActionPolicyResolver,
  ToolActionPolicyResolverInput,
  ToolActionPolicyResolution,
  ToolActionPolicySafetyGate,
  ToolActionPolicySource,
  ToolAdmissionBehavior,
  ToolBoxPolicy,
  ToolEffectClass,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  ToolGovernanceDescriptorSource,
  ToolGovernanceResolution,
  ToolGovernanceRisk,
  ToolMutationRollbackFailureReason,
  ToolMutationRollbackKind,
  ToolMutationRollbackResult,
  ToolMutationStrategy,
  ToolReceiptPolicy,
  ToolRecoveryPolicy,
  ToolRecoveryPreparation,
  ToolRiskLevel,
} from "./runtime/kernel/policy/public-contract.js";
export type {
  CredentialVaultDiscoveredEntry,
  CredentialVaultListEntry,
  CredentialVaultServiceOptions,
} from "./credentials/credential-vault.js";

export type CredentialVaultService = InternalCredentialVaultService & {
  readonly name: "credentials.vault";
};

function withName(instance: InternalCredentialVaultService): CredentialVaultService {
  return Object.assign(instance, { name: "credentials.vault" as const });
}

export function createCredentialVaultService(
  options: ConstructorParameters<typeof InternalCredentialVaultService>[0],
): CredentialVaultService {
  return withName(new InternalCredentialVaultService(options));
}

export function createCredentialVaultServiceFromSecurityConfig(
  ...args: Parameters<typeof createInternalCredentialVaultServiceFromSecurityConfig>
): CredentialVaultService {
  return withName(createInternalCredentialVaultServiceFromSecurityConfig(...args));
}
