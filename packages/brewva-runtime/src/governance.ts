// Curated governance contract subpath. Keep root imports focused on BrewvaRuntime.
export type {
  EffectAuthorityManifestBasis,
  EffectiveToolActionPolicy,
  MutationReceipt,
  MutationSubject,
  PatchSetRedoFailureReason,
  PatchSetRollbackFailureReason,
  ToolActionAdmissionOverrides,
  ToolActionClass,
  ToolActionPolicy,
  ToolActionPolicyResolver,
  ToolActionPolicyResolverInput,
  ToolActionPolicySafetyGate,
  ToolAdmissionBehavior,
  ToolBoxPolicy,
  ToolEffectClass,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  ToolGovernanceRisk,
  ToolMutationRollbackFailureReason,
  ToolMutationRollbackKind,
  ToolMutationRollbackResult,
  ToolMutationStrategy,
  ToolReceiptPolicy,
  ToolRecoveryPolicy,
  ToolRiskLevel,
} from "./domain/governance/types.js";
export {
  ActionPolicyRegistry,
  TOOL_ACTION_CLASSES,
  TOOL_ACTION_POLICY_BY_NAME,
  TOOL_ADMISSION_BEHAVIORS,
  compareToolAdmission,
  createActionPolicyRegistry,
  deriveToolGovernanceDescriptor,
  getExactToolActionPolicy,
  getToolActionClassAdmissionBounds,
  getToolActionPolicy,
  getToolActionPolicyResolution,
  resolveEffectiveToolActionPolicy,
  resolveToolExecutionBoundaryFromEffects,
  sameToolActionPolicy,
  toolActionPolicyCreatesRollbackAnchor,
  toolActionPolicyRequiresApproval,
  validateToolActionPolicy,
} from "./domain/governance/action-policy.js";
export type {
  ToolActionPolicyResolution,
  ToolActionPolicySource,
} from "./domain/governance/action-policy.js";
export type {
  GovernanceAuthorizeEffectCommitmentInput,
  GovernanceAuthorizeEffectCommitmentOutput,
  GovernanceCompactionIntegrityInput,
  GovernanceCompactionIntegrityOutput,
  GovernanceCostAnomalyInput,
  GovernanceCostAnomalyOutput,
  GovernancePort,
  GovernanceVerifySpecInput,
  GovernanceVerifySpecOutput,
} from "./domain/governance/port.js";
export { createTrustedLocalGovernancePort } from "./domain/governance/trusted-local-port.js";
export type {
  TrustedLocalGovernancePortOptions,
  TrustedLocalGovernanceProfile,
} from "./domain/governance/trusted-local-port.js";
export {
  buildEffectAuthorityManifestBasis,
  decideEffectAuthorityManifest,
  type EffectAuthorityManifestFacts,
} from "./domain/governance/effect-authority-manifest.js";
