import type { CommandPolicySummary } from "../../security/command-policy.js";
import type { VirtualReadonlyPolicySummary } from "../../security/virtual-readonly-policy.js";
import type { ToolActionPolicySource } from "./action-policy.js";
import type {
  EffectAuthorityManifestBasis,
  ToolActionClass,
  ToolAdmissionBehavior,
  ToolEffectClass,
  ToolExecutionBoundary,
  ToolReceiptPolicy,
  ToolRecoveryPolicy,
  ToolRiskLevel,
} from "./types.js";

export type EffectAuthorityDecisionKind = "allow" | "block" | "defer";

export interface EffectAuthorityFactDecision {
  allowed: boolean;
  basis: string;
  reason?: string;
  advisory?: string;
  terminalFailure?: boolean;
}

export interface EffectAuthorityManifestFacts {
  toolName: string;
  boundary: ToolExecutionBoundary;
  authoritySource: ToolActionPolicySource;
  actionClass?: ToolActionClass;
  riskLevel?: ToolRiskLevel;
  effectiveAdmission?: ToolAdmissionBehavior;
  effects: readonly ToolEffectClass[];
  requiresApproval: boolean;
  rollbackable: boolean;
  receiptPolicy?: ToolReceiptPolicy;
  recoveryPolicy?: ToolRecoveryPolicy;
  policyBasis?: readonly string[];
  controlPlaneTool: boolean;
  commandPolicy?: CommandPolicySummary;
  virtualReadonly?: VirtualReadonlyPolicySummary;
  skillAccess?: EffectAuthorityFactDecision;
  repairAccess?: EffectAuthorityFactDecision;
  budgetAccess?: EffectAuthorityFactDecision;
  skillTokenAccess?: EffectAuthorityFactDecision;
  skillToolCallAccess?: EffectAuthorityFactDecision;
  routingAccess?: EffectAuthorityFactDecision;
  boundaryAccess?: EffectAuthorityFactDecision;
  deduplicationAccess?: EffectAuthorityFactDecision;
  capabilityAccess?: EffectAuthorityFactDecision;
  inflightEffectAccess?: EffectAuthorityFactDecision;
}

export interface EffectAuthorityManifestDecision {
  allowed: boolean;
  decision: EffectAuthorityDecisionKind;
  reason?: string;
  advisory?: string;
  requiresApproval: boolean;
  receiptRequired: boolean;
  manifestBasis: EffectAuthorityManifestBasis;
}

const EXACT_AUTHORITY_SOURCES = new Set<ToolActionPolicySource>(["exact", "registry"]);

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}

function receiptRequired(policy: ToolReceiptPolicy | undefined): boolean {
  return policy?.required === true;
}

function receiptPolicyBasis(policy: ToolReceiptPolicy | undefined): string | undefined {
  return policy ? `receipt:${policy.kind}` : undefined;
}

function recoveryPolicyBasis(policy: ToolRecoveryPolicy | undefined): string | undefined {
  return policy ? `recovery:${policy.kind}` : undefined;
}

function factBasis(fact: EffectAuthorityFactDecision | undefined): string | undefined {
  return fact?.basis;
}

function resolveLocalExecReadonlyAccess(
  facts: EffectAuthorityManifestFacts,
): EffectAuthorityFactDecision | undefined {
  if (facts.actionClass !== "local_exec_readonly") {
    return undefined;
  }
  if (!facts.commandPolicy) {
    return {
      allowed: false,
      basis: "local_exec_readonly_virtual_route",
      reason: "local_exec_readonly requires command policy analysis.",
    };
  }
  if (!facts.commandPolicy.readonlyEligible) {
    const unsupported =
      facts.commandPolicy.unsupportedReasons.length > 0
        ? ` Unsupported command grammar: ${facts.commandPolicy.unsupportedReasons
            .map((reason) => reason.code)
            .join(", ")}.`
        : "";
    return {
      allowed: false,
      basis: "local_exec_readonly_virtual_route",
      reason: `local_exec_readonly requires a readonly-eligible command.${unsupported}`,
    };
  }
  if (!facts.virtualReadonly) {
    return {
      allowed: false,
      basis: "local_exec_readonly_virtual_route",
      reason: "local_exec_readonly requires virtual readonly eligibility.",
    };
  }
  if (!facts.virtualReadonly.eligible) {
    const blockedReasons = facts.virtualReadonly.blockedReasons
      .map((reason) => reason.code)
      .filter((code) => code.length > 0);
    const suffix =
      blockedReasons.length > 0 ? ` Blocked reasons: ${blockedReasons.join(", ")}.` : "";
    return {
      allowed: false,
      basis: "local_exec_readonly_virtual_route",
      reason: `local_exec_readonly requires a virtual readonly route.${suffix}`,
    };
  }
  return {
    allowed: true,
    basis: "local_exec_readonly_virtual_route",
  };
}

function factAdvisories(facts: EffectAuthorityManifestFacts): string[] {
  return [
    facts.skillAccess?.advisory,
    facts.repairAccess?.advisory,
    facts.budgetAccess?.advisory,
    facts.skillTokenAccess?.advisory,
    facts.skillToolCallAccess?.advisory,
    facts.routingAccess?.advisory,
    facts.boundaryAccess?.advisory,
    facts.deduplicationAccess?.advisory,
    facts.capabilityAccess?.advisory,
    facts.inflightEffectAccess?.advisory,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

interface EnrichedEffectAuthorityRuntimeFacts {
  localExecReadonlyAccess?: EffectAuthorityFactDecision;
}

function enrichEffectAuthorityRuntimeFacts(
  facts: EffectAuthorityManifestFacts,
): EnrichedEffectAuthorityRuntimeFacts {
  return {
    localExecReadonlyAccess: resolveLocalExecReadonlyAccess(facts),
  };
}

function buildEffectAuthorityManifestBasisFromRuntimeFacts(
  facts: EffectAuthorityManifestFacts,
  runtimeFacts: EnrichedEffectAuthorityRuntimeFacts,
): EffectAuthorityManifestBasis {
  const toolName = normalizeToolName(facts.toolName);
  return {
    schema: "brewva.effect_authority_basis.v1",
    toolName,
    boundary: facts.boundary,
    authoritySource: facts.authoritySource,
    actionClass: facts.actionClass,
    riskLevel: facts.riskLevel,
    effectiveAdmission: facts.effectiveAdmission,
    effects: [...facts.effects],
    requiresApproval: facts.requiresApproval,
    rollbackable: facts.rollbackable,
    receiptRequired: receiptRequired(facts.receiptPolicy),
    invariantBasis: unique([
      "exact_action_policy_required",
      facts.actionClass === "local_exec_readonly"
        ? "local_exec_readonly_virtual_route_required"
        : undefined,
    ]),
    overlayBasis: unique([
      facts.actionClass ? `action_policy:${facts.actionClass}` : undefined,
      facts.effectiveAdmission ? `admission:${facts.effectiveAdmission}` : undefined,
      ...(facts.policyBasis ?? []),
      facts.controlPlaneTool ? "control_plane_tool" : undefined,
    ]),
    runtimeBasis: unique([
      factBasis(facts.capabilityAccess),
      factBasis(facts.routingAccess),
      factBasis(facts.skillAccess),
      factBasis(facts.repairAccess),
      factBasis(facts.budgetAccess),
      factBasis(facts.skillTokenAccess),
      factBasis(facts.skillToolCallAccess),
      factBasis(facts.deduplicationAccess),
      factBasis(facts.boundaryAccess),
      factBasis(runtimeFacts.localExecReadonlyAccess),
      factBasis(facts.inflightEffectAccess),
      facts.commandPolicy ? "command_policy" : undefined,
      facts.virtualReadonly ? "virtual_readonly_policy" : undefined,
    ]),
    receiptBasis: unique([
      receiptPolicyBasis(facts.receiptPolicy),
      recoveryPolicyBasis(facts.recoveryPolicy),
      facts.requiresApproval ? "operator_approval_required" : undefined,
    ]),
  };
}

export function buildEffectAuthorityManifestBasis(
  facts: EffectAuthorityManifestFacts,
): EffectAuthorityManifestBasis {
  return buildEffectAuthorityManifestBasisFromRuntimeFacts(
    facts,
    enrichEffectAuthorityRuntimeFacts(facts),
  );
}

function firstBlockingFact(
  facts: EffectAuthorityManifestFacts,
  enriched: EnrichedEffectAuthorityRuntimeFacts,
): EffectAuthorityFactDecision | undefined {
  const orderedRuntimeFacts = [
    enriched.localExecReadonlyAccess,
    facts.capabilityAccess,
    facts.routingAccess,
    facts.boundaryAccess,
    facts.deduplicationAccess,
    facts.inflightEffectAccess,
    facts.controlPlaneTool ? undefined : facts.skillAccess,
    facts.repairAccess,
    facts.controlPlaneTool ? undefined : facts.budgetAccess,
    facts.controlPlaneTool ? undefined : facts.skillTokenAccess,
    facts.controlPlaneTool ? undefined : facts.skillToolCallAccess,
  ];
  return orderedRuntimeFacts.find((fact) => fact && !fact.allowed);
}

export function decideEffectAuthorityManifest(
  facts: EffectAuthorityManifestFacts,
): EffectAuthorityManifestDecision {
  const toolName = normalizeToolName(facts.toolName);
  const runtimeFacts = enrichEffectAuthorityRuntimeFacts(facts);
  const manifestBasis = buildEffectAuthorityManifestBasisFromRuntimeFacts(facts, runtimeFacts);
  const advisory = unique(factAdvisories(facts)).join("; ") || undefined;

  if (!EXACT_AUTHORITY_SOURCES.has(facts.authoritySource)) {
    return {
      allowed: false,
      decision: "block",
      reason: `Tool '${toolName}' requires an exact action policy.`,
      advisory,
      requiresApproval: false,
      receiptRequired: receiptRequired(facts.receiptPolicy),
      manifestBasis,
    };
  }

  const blockingFact = firstBlockingFact(facts, runtimeFacts);
  if (blockingFact) {
    return {
      allowed: false,
      decision: "block",
      reason: blockingFact.reason ?? "Tool call blocked.",
      advisory,
      requiresApproval: false,
      receiptRequired: receiptRequired(facts.receiptPolicy),
      manifestBasis,
    };
  }

  if (facts.effectiveAdmission === "deny") {
    return {
      allowed: false,
      decision: "block",
      reason: `Tool '${toolName}' is denied by action admission policy.`,
      advisory,
      requiresApproval: false,
      receiptRequired: receiptRequired(facts.receiptPolicy),
      manifestBasis,
    };
  }

  return {
    allowed: true,
    decision: facts.requiresApproval ? "defer" : "allow",
    advisory,
    requiresApproval: facts.requiresApproval,
    receiptRequired: receiptRequired(facts.receiptPolicy),
    manifestBasis,
  };
}
