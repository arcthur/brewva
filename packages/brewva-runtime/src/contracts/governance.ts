import type { BrewvaToolCallId, BrewvaToolName } from "./identifiers.js";
import type { RollbackOutcome } from "./shared.js";
import type { SkillRoutingScope } from "./skill.js";

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

export interface ToolSandboxPolicy {
  kind: "none" | "host_effect" | "sandbox_required";
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
  sandboxPolicy?: ToolSandboxPolicy;
  budgetWeight?: number;
  requiredRoutingScopes?: SkillRoutingScope[];
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
  rollbackable?: boolean;
  requiredRoutingScopes?: SkillRoutingScope[];
}

export type ToolMutationStrategy = "workspace_patchset";

export type ToolMutationRollbackKind = "patchset";

export interface ToolMutationReceipt {
  id: string;
  toolCallId: BrewvaToolCallId;
  toolName: BrewvaToolName;
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
  toolName?: string;
  strategy?: ToolMutationStrategy;
  rollbackKind?: ToolMutationRollbackKind;
};
