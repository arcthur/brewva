import { normalizeToolName } from "../../../utils/tool-name.js";
import { deriveEffectCommitmentPosture, resolveToolRecoveryPreparation } from "./effect-posture.js";
import type {
  EffectCommitmentPosture,
  EffectiveToolActionPolicy,
  ToolActionAdmissionOverrides,
  ToolActionPolicy,
  ToolEffectClass,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  ToolRecoveryPreparation,
} from "./policy-types.js";
import {
  type ActionPolicyRegistry,
  deriveToolGovernanceDescriptor,
  getToolActionPolicy,
  getToolActionPolicyResolution,
  resolveEffectiveToolActionPolicy,
  resolveToolExecutionBoundaryFromEffects,
  toolActionPolicyRequiresApproval,
  type ToolActionPolicyResolution,
  type ToolActionPolicySource,
} from "./tool-admission-policy.js";

export type ToolGovernanceDescriptorSource = ToolActionPolicySource;

export interface ToolGovernanceResolution {
  descriptor?: ToolGovernanceDescriptor;
  policy?: ToolActionPolicy;
  effectivePolicy?: EffectiveToolActionPolicy;
  source: ToolGovernanceDescriptorSource;
}

export interface ResolvedToolAuthority {
  normalizedToolName: string;
  descriptor?: ToolGovernanceDescriptor;
  actionPolicy?: EffectiveToolActionPolicy;
  source: ToolGovernanceDescriptorSource;
  boundary: ToolExecutionBoundary;
  requiresApproval: boolean;
  recoveryPreparation: ToolRecoveryPreparation;
  commitmentPosture?: EffectCommitmentPosture;
  actionClass?: ToolActionPolicy["actionClass"];
  riskLevel?: ToolActionPolicy["riskLevel"];
  defaultAdmission?: ToolActionPolicy["defaultAdmission"];
  maxAdmission?: ToolActionPolicy["maxAdmission"];
  effectiveAdmission?: EffectiveToolActionPolicy["effectiveAdmission"];
  receiptPolicy?: ToolActionPolicy["receiptPolicy"];
  recoveryPolicy?: ToolActionPolicy["recoveryPolicy"];
  policyBasis?: readonly string[];
}

function resolveAuthorityFromResolution(
  toolName: string,
  resolution: ToolActionPolicyResolution,
  admissionOverrides?: ToolActionAdmissionOverrides,
): ResolvedToolAuthority {
  const normalizedToolName = normalizeToolName(toolName);
  const policy = resolution.policy;
  const effectivePolicy = policy
    ? resolveEffectiveToolActionPolicy(policy, admissionOverrides?.[policy.actionClass])
    : undefined;
  const descriptor = effectivePolicy ? deriveToolGovernanceDescriptor(effectivePolicy) : undefined;
  const recoveryPreparation = effectivePolicy
    ? resolveToolRecoveryPreparation(effectivePolicy)
    : "none";
  const commitmentPosture = effectivePolicy
    ? deriveEffectCommitmentPosture({
        effects: effectivePolicy.effectClasses,
        receiptPolicy: effectivePolicy.receiptPolicy,
        recoveryPolicy: effectivePolicy.recoveryPolicy,
        recoveryPreparation,
      })
    : undefined;
  return {
    normalizedToolName,
    descriptor,
    actionPolicy: effectivePolicy,
    source: resolution.source,
    boundary: descriptor?.boundary ?? "effectful",
    requiresApproval: effectivePolicy ? toolActionPolicyRequiresApproval(effectivePolicy) : true,
    recoveryPreparation,
    commitmentPosture,
    actionClass: effectivePolicy?.actionClass,
    riskLevel: effectivePolicy?.riskLevel,
    defaultAdmission: effectivePolicy?.defaultAdmission,
    maxAdmission: effectivePolicy?.maxAdmission,
    effectiveAdmission: effectivePolicy?.effectiveAdmission,
    receiptPolicy: effectivePolicy?.receiptPolicy,
    recoveryPolicy: effectivePolicy?.recoveryPolicy,
    policyBasis: effectivePolicy?.safetyGate?.reason ? [effectivePolicy.safetyGate.reason] : [],
  };
}

export function getToolGovernanceDescriptor(
  toolName: string,
  registry?: Pick<ActionPolicyRegistry, "get">,
  args?: Record<string, unknown>,
): ToolGovernanceDescriptor | undefined {
  const policy = getToolActionPolicy(toolName, registry, args);
  return policy ? deriveToolGovernanceDescriptor(policy) : undefined;
}

export function getToolGovernanceResolution(
  toolName: string,
  registry?: Pick<ActionPolicyRegistry, "resolve">,
  args?: Record<string, unknown>,
  admissionOverrides?: ToolActionAdmissionOverrides,
): ToolGovernanceResolution {
  const resolution = getToolActionPolicyResolution(toolName, registry, args);
  const authority = resolveAuthorityFromResolution(toolName, resolution, admissionOverrides);
  return {
    descriptor: authority.descriptor,
    policy: resolution.policy,
    effectivePolicy: authority.actionPolicy,
    source: authority.source,
  };
}

export function resolveToolAuthority(
  toolName: string,
  registry?: Pick<ActionPolicyRegistry, "resolve">,
  args?: Record<string, unknown>,
  admissionOverrides?: ToolActionAdmissionOverrides,
): ResolvedToolAuthority {
  return resolveAuthorityFromResolution(
    toolName,
    getToolActionPolicyResolution(toolName, registry, args),
    admissionOverrides,
  );
}

export function resolveToolExecutionBoundary(
  toolName: string,
  registry?: Pick<ActionPolicyRegistry, "resolve">,
  args?: Record<string, unknown>,
  admissionOverrides?: ToolActionAdmissionOverrides,
): ToolExecutionBoundary {
  return resolveToolAuthority(toolName, registry, args, admissionOverrides).boundary;
}

export function toolEffectsRequireEffectCommitment(effects: readonly ToolEffectClass[]): boolean {
  return effects.some(
    (effect) =>
      effect === "local_exec" ||
      effect === "external_network" ||
      effect === "external_side_effect" ||
      effect === "schedule_mutation" ||
      effect === "credential_access",
  );
}

export function toolGovernanceRequiresEffectCommitment(
  toolDescriptor: ToolGovernanceDescriptor | undefined,
): boolean {
  return toolEffectsRequireEffectCommitment(toolDescriptor?.effects ?? []);
}

export { resolveToolExecutionBoundaryFromEffects };
