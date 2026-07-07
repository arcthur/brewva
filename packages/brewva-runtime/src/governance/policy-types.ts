import type { BrewvaToolCallId, BrewvaToolName } from "../core/identifiers-bridge.js";
import type { RollbackOutcome } from "../core/shared.js";

export type ToolEffectClass =
  | "workspace_read"
  | "workspace_write"
  | "local_exec"
  | "runtime_observe"
  | "external_network"
  | "external_side_effect"
  | "schedule_mutation"
  | "memory_write"
  | "budget_mutation"
  | "control_state_mutation"
  | "delegation"
  | "credential_access";
export type ToolRiskLevel = "low" | "medium" | "high" | "critical";
export type ToolGovernanceRisk = ToolRiskLevel;
export type ToolExecutionBoundary = "safe" | "effectful";
export type ToolActionClass =
  | "workspace_read"
  | "runtime_observe"
  | "observe_compound"
  | "workspace_patch"
  | "memory_write"
  | "control_state_mutation"
  | "budget_mutation"
  | "local_exec_readonly"
  | "local_exec_effectful"
  | "external_side_effect"
  | "schedule_mutation"
  | "delegation"
  | "credential_access";
export type ToolAdmissionBehavior = "allow" | "ask" | "deny";
export type EffectRecoverability =
  | "observe_only"
  | "reversible"
  | "compensatable"
  | "manual_recovery"
  | "irreversible";
export type EffectVisibility =
  | "local_only"
  | "workspace_visible"
  | "externally_observable"
  | "credential_sensitive";
export type EffectPostureEvidenceSource =
  | "execution_receipt"
  | "effect_authority_manifest"
  | "action_policy"
  | "managed_tool_metadata"
  | "skill_metadata"
  | "prose";
export type EffectPostureWarningCode =
  | "reversible_requires_undo_handle"
  | "external_evidence_overrode_reversible"
  | "credential_evidence_overrode_visibility"
  | "classification_changed_after_receipt"
  | "missing_effect_evidence";
export type ToolRecoveryPreparation = "none" | "workspace_patchset" | "compensation" | "manual";

export interface EffectPostureWarning {
  code: EffectPostureWarningCode;
  message: string;
  evidenceSource?: EffectPostureEvidenceSource;
}

export interface EffectProjectionWarning extends EffectPostureWarning {
  eventId?: string;
  toolName?: string;
  receiptId?: string;
}

export interface EffectCommitmentPosture {
  recoverability: EffectRecoverability;
  visibility: EffectVisibility;
  evidenceSources: EffectPostureEvidenceSource[];
  warnings: EffectPostureWarning[];
}

export type ToolReceiptPolicy =
  | { kind: "none"; required?: false }
  | { kind: "audit"; required: boolean }
  | { kind: "mutation"; required: true }
  | { kind: "commitment"; required: true }
  | { kind: "control_plane"; required: true }
  | { kind: "execution"; required: true }
  | { kind: "delegation"; required: true }
  | { kind: "security_audit"; required: true };

export type ToolRecoveryPolicy =
  | { kind: "none"; scope?: "parent_delegation" }
  | { kind: "exact_patch"; strategy: "workspace_patchset" }
  | { kind: "artifact_cleanup" }
  | { kind: "compensation"; mode: "async_cancel" | "manual" }
  | { kind: "manual_recovery_evidence" }
  | { kind: "forward_correction" };

export interface ToolBoxPolicy {
  kind: "none" | "host_effect" | "box_required";
  scopeKind?: "session" | "task" | "ephemeral";
  imageOverride?: string;
  networkAllowlist?: string[];
  requiresSnapshotBefore?: boolean;
  allowDetachedExecution?: boolean;
}

export interface ToolActionPolicySafetyGate {
  localExecReadonlyAutoAllow?: boolean;
  reason?: string;
}

export interface ToolActionPolicy {
  actionClass: ToolActionClass;
  riskLevel: ToolRiskLevel;
  defaultAdmission: ToolAdmissionBehavior;
  maxAdmission: ToolAdmissionBehavior;
  receiptPolicy: ToolReceiptPolicy;
  recoveryPolicy: ToolRecoveryPolicy;
  effectClasses: ToolEffectClass[];
  boxPolicy?: ToolBoxPolicy;
  budgetWeight?: number;
  safetyGate?: ToolActionPolicySafetyGate;
}

export interface ToolActionPolicyResolverInput {
  toolName: string;
  args?: Record<string, unknown>;
}

export type ToolActionPolicyResolver = (
  input: ToolActionPolicyResolverInput,
) => ToolActionPolicy | undefined;

export type ToolActionAdmissionOverrides = Partial<Record<ToolActionClass, ToolAdmissionBehavior>>;

export interface EffectiveToolActionPolicy extends ToolActionPolicy {
  effectiveAdmission: ToolAdmissionBehavior;
}

export interface ToolGovernanceDescriptor {
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  boundary?: ToolExecutionBoundary;
}

export interface EffectAuthorityManifestBasis {
  schema: "brewva.effect_authority_basis.v2";
  toolName: string;
  boundary: ToolExecutionBoundary;
  authoritySource: string;
  actionClass?: ToolActionClass;
  riskLevel?: ToolRiskLevel;
  effectiveAdmission?: ToolAdmissionBehavior;
  effects: ToolEffectClass[];
  requiresApproval: boolean;
  recoveryPreparation: ToolRecoveryPreparation;
  commitmentPosture: EffectCommitmentPosture;
  receiptRequired: boolean;
  invariantBasis: string[];
  overlayBasis: string[];
  runtimeBasis: string[];
  receiptBasis: string[];
}

export type ToolMutationStrategy = "workspace_patchset";

export type ToolMutationRollbackKind = "patchset";

export type MutationSubject =
  | {
      kind: "tool";
      toolCallId: BrewvaToolCallId;
      toolName: BrewvaToolName;
    }
  | {
      kind: "convention";
      requestId: string;
      target: Record<string, unknown>;
    };

export interface MutationReceipt {
  id: string;
  subject: MutationSubject;
  boundary: "effectful";
  strategy: ToolMutationStrategy;
  rollbackKind: ToolMutationRollbackKind;
  effects: ToolEffectClass[];
  turn: number;
  timestamp: number;
}

export type PatchSetRollbackFailureReason =
  | "no_patchset"
  | "restore_failed"
  | "patchset_not_latest";

export type PatchSetRedoFailureReason =
  | "no_undone_patchset"
  | "restore_failed"
  | "patchset_not_latest"
  | "missing_redo_snapshot"
  | "current_state_mismatch";

export type ToolMutationRollbackFailureReason =
  | "no_mutation_receipt"
  | PatchSetRollbackFailureReason;

export type ToolMutationRollbackResult = RollbackOutcome<ToolMutationRollbackFailureReason> & {
  receiptId?: string;
  patchSetId?: string;
  subject?: MutationSubject;
  toolName?: string;
  strategy?: ToolMutationStrategy;
  rollbackKind?: ToolMutationRollbackKind;
};
