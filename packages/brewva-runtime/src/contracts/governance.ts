import type { RollbackOutcome } from "./shared.js";

export type ToolEffectClass =
  | "workspace_read"
  | "workspace_write"
  | "local_exec"
  | "runtime_observe"
  | "external_network"
  | "external_side_effect"
  | "schedule_mutation"
  | "memory_write";
export type ToolGovernanceRisk = "low" | "medium" | "high";
export type ToolExecutionBoundary = "safe" | "effectful";

export interface ToolGovernanceDescriptor {
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  boundary?: ToolExecutionBoundary;
  rollbackable?: boolean;
}

export interface ToolGovernanceResolverInput {
  toolName: string;
  args?: Record<string, unknown>;
}

export type ToolGovernanceResolver = (
  input: ToolGovernanceResolverInput,
) => ToolGovernanceDescriptor | undefined;

export type ToolMutationStrategy = "workspace_patchset";

export type ToolMutationRollbackKind = "patchset";

export interface ToolMutationReceipt {
  id: string;
  toolCallId: string;
  toolName: string;
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

export type ToolMutationRollbackFailureReason =
  | "no_mutation_receipt"
  | PatchSetRollbackFailureReason;

export interface ToolMutationRollbackResult extends RollbackOutcome<ToolMutationRollbackFailureReason> {
  receiptId?: string;
  patchSetId?: string;
  toolName?: string;
  strategy?: ToolMutationStrategy;
  rollbackKind?: ToolMutationRollbackKind;
}
