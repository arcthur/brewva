import type {
  EffectAuthorityManifestBasis,
  ToolActionClass,
  ToolActionPolicySafetyGate,
  ToolAdmissionBehavior,
  ToolExecutionBoundary,
} from "../../governance/policy-types.js";

export type OperatorSafetyDecision = "allow" | "ask" | "deny";

export interface SandboxPosture {
  readonly backend: "n/a" | "virtual_readonly" | "box" | "host";
  readonly status: "ok" | "unavailable" | "blocked" | "violated" | "failed";
  readonly evidenceEventId?: string;
}

export type DenialReasonCategory =
  | "denied_by_policy"
  | "missing_capability"
  | "sandbox_blocked"
  | "sandbox_failed"
  | "sandbox_unavailable"
  | "sandbox_violated"
  | "sandbox_wrong_backend"
  | "approval_cancelled"
  | "evidence_missing";

export type OperatorSafetyRetryHint =
  | "try_other_tool"
  | "request_approval"
  | "gather_evidence"
  | "none";

export interface DenialReason {
  readonly category: DenialReasonCategory;
  readonly toolName: string;
  readonly actionClass: ToolActionClass;
  readonly manifestBasis?: string;
  readonly capabilityReceiptId?: string;
  readonly redactedEvidenceRefs: readonly string[];
  readonly retryHint: OperatorSafetyRetryHint;
}

export interface OperatorSafetyCapabilityBasis {
  readonly allowed?: boolean;
  readonly receiptId?: string;
  readonly source?: string;
  readonly selectedCapabilityNames?: readonly string[];
  readonly reason?: string;
}

export interface OperatorSafetyDecisionView {
  readonly decision: OperatorSafetyDecision;
  readonly toolName: string;
  readonly actionClass: ToolActionClass;
  readonly effectBoundary: ToolExecutionBoundary;
  readonly consequencePosture: string;
  readonly manifestBasis?: string;
  readonly policyBasis: readonly string[];
  readonly targetScope: readonly string[];
  readonly receiptIds: readonly string[];
  readonly pendingRequestId?: string;
  readonly capabilityBasis?: OperatorSafetyCapabilityBasis;
  readonly sandbox?: SandboxPosture;
  readonly denialReason?: DenialReason;
}

export interface ProjectOperatorSafetyDecisionInput {
  readonly kernelDecision: ToolAdmissionBehavior;
  readonly toolName: string;
  readonly actionClass: ToolActionClass;
  readonly effectBoundary: ToolExecutionBoundary;
  readonly consequencePosture: string;
  readonly manifestBasis?: EffectAuthorityManifestBasis;
  readonly policyBasis?: string | readonly string[];
  readonly targetScope?: readonly string[];
  readonly receiptIds?: readonly string[];
  readonly pendingRequestId?: string;
  readonly safetyGate?: ToolActionPolicySafetyGate;
  readonly capabilityBasis?: OperatorSafetyCapabilityBasis;
  readonly sandbox?: SandboxPosture;
  readonly kernelReason?: string;
}

const DECISION_RANK: Record<OperatorSafetyDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function renderManifestBasis(
  manifestBasis: EffectAuthorityManifestBasis | undefined,
): string | undefined {
  if (!manifestBasis) {
    return undefined;
  }
  return [
    manifestBasis.schema,
    manifestBasis.toolName,
    manifestBasis.authoritySource,
    manifestBasis.actionClass ?? "unknown_action",
    manifestBasis.effectiveAdmission ?? "unknown_admission",
  ].join(":");
}

function normalizePolicyBasis(value: string | readonly string[] | undefined): readonly string[] {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return [];
}

function retryHintForCategory(category: DenialReasonCategory): OperatorSafetyRetryHint {
  switch (category) {
    case "missing_capability":
      return "gather_evidence";
    case "sandbox_blocked":
    case "sandbox_failed":
    case "sandbox_unavailable":
    case "sandbox_violated":
    case "sandbox_wrong_backend":
      return "request_approval";
    case "evidence_missing":
      return "gather_evidence";
    case "approval_cancelled":
      return "request_approval";
    case "denied_by_policy":
      return "try_other_tool";
  }
  return "none";
}

function sandboxCategory(sandbox: SandboxPosture | undefined): DenialReasonCategory {
  switch (sandbox?.status) {
    case "unavailable":
      return "sandbox_unavailable";
    case "violated":
      return "sandbox_violated";
    case "failed":
      return "sandbox_failed";
    case "blocked":
      return "sandbox_blocked";
    case "ok":
      return sandbox.backend === "virtual_readonly" ? "sandbox_blocked" : "sandbox_wrong_backend";
    case undefined:
      return "evidence_missing";
  }
  return "evidence_missing";
}

function deriveDeniedCategory(input: ProjectOperatorSafetyDecisionInput): DenialReasonCategory {
  if (input.capabilityBasis?.allowed === false) {
    return "missing_capability";
  }
  if (
    input.kernelReason === "approval_request_cancelled" ||
    input.kernelReason === "approval_request_expired" ||
    input.kernelReason?.startsWith("approval_args_digest_")
  ) {
    // The approval closure ended without an exercisable acceptance (operator
    // cancel, closure bound elapsed, or argument identity drifted); the path
    // forward is a fresh approval request, not a different tool.
    return "approval_cancelled";
  }
  if (input.kernelReason === "missing_selected_capability") {
    return "missing_capability";
  }
  if (input.kernelReason?.startsWith("sandbox_") || input.kernelReason?.startsWith("box_")) {
    return sandboxCategory(input.sandbox);
  }
  return "denied_by_policy";
}

function buildDenialReason(
  input: ProjectOperatorSafetyDecisionInput,
  category: DenialReasonCategory,
): DenialReason {
  const manifestBasis = renderManifestBasis(input.manifestBasis);
  return {
    category,
    toolName: input.toolName,
    actionClass: input.actionClass,
    ...(manifestBasis ? { manifestBasis } : {}),
    ...(input.capabilityBasis?.receiptId
      ? { capabilityReceiptId: input.capabilityBasis.receiptId }
      : {}),
    redactedEvidenceRefs: [
      ...(input.receiptIds ?? []),
      ...(input.sandbox?.evidenceEventId ? [input.sandbox.evidenceEventId] : []),
    ],
    retryHint: retryHintForCategory(category),
  };
}

function withNoWidening(
  kernelDecision: OperatorSafetyDecision,
  candidate: OperatorSafetyDecision,
): OperatorSafetyDecision {
  return DECISION_RANK[candidate] < DECISION_RANK[kernelDecision] ? kernelDecision : candidate;
}

function projectDecision(input: ProjectOperatorSafetyDecisionInput): {
  readonly decision: OperatorSafetyDecision;
  readonly denialReason?: DenialReason;
} {
  if (input.kernelDecision === "deny") {
    const category = deriveDeniedCategory(input);
    return {
      decision: "deny",
      denialReason: buildDenialReason(input, category),
    };
  }

  if (input.capabilityBasis?.allowed === false) {
    return {
      decision: "deny",
      denialReason: buildDenialReason(input, "missing_capability"),
    };
  }

  if (!input.manifestBasis) {
    return {
      decision: withNoWidening(input.kernelDecision, "ask"),
    };
  }

  if (input.actionClass === "local_exec_readonly") {
    if (input.safetyGate?.localExecReadonlyAutoAllow !== true) {
      return {
        decision: withNoWidening(input.kernelDecision, "ask"),
      };
    }
    if (!input.sandbox) {
      return {
        decision: withNoWidening(input.kernelDecision, "ask"),
      };
    }
    if (input.sandbox.backend !== "virtual_readonly" || input.sandbox.status !== "ok") {
      const category = sandboxCategory(input.sandbox);
      return {
        decision: withNoWidening(input.kernelDecision, "deny"),
        denialReason: buildDenialReason(input, category),
      };
    }
  }

  return { decision: input.kernelDecision };
}

export function projectOperatorSafetyDecision(
  input: ProjectOperatorSafetyDecisionInput,
): OperatorSafetyDecisionView {
  try {
    const projected = projectDecision(input);
    const manifestBasis = renderManifestBasis(input.manifestBasis);
    return {
      decision: projected.decision,
      toolName: input.toolName,
      actionClass: input.actionClass,
      effectBoundary: input.effectBoundary,
      consequencePosture: input.consequencePosture,
      ...(manifestBasis ? { manifestBasis } : {}),
      policyBasis: normalizePolicyBasis(input.policyBasis),
      targetScope: input.targetScope ?? [],
      receiptIds: input.receiptIds ?? [],
      ...(input.pendingRequestId ? { pendingRequestId: input.pendingRequestId } : {}),
      ...(input.capabilityBasis ? { capabilityBasis: input.capabilityBasis } : {}),
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      ...(projected.denialReason ? { denialReason: projected.denialReason } : {}),
    };
  } catch {
    if (input.kernelDecision === "deny") {
      const denialReason = buildDenialReason(input, deriveDeniedCategory(input));
      return {
        decision: "deny",
        toolName: input.toolName,
        actionClass: input.actionClass,
        effectBoundary: input.effectBoundary,
        consequencePosture: input.consequencePosture,
        policyBasis: normalizePolicyBasis(input.policyBasis),
        targetScope: input.targetScope ?? [],
        receiptIds: input.receiptIds ?? [],
        denialReason,
      };
    }
    return {
      decision: "ask",
      toolName: input.toolName,
      actionClass: input.actionClass,
      effectBoundary: input.effectBoundary,
      consequencePosture: input.consequencePosture,
      policyBasis: normalizePolicyBasis(input.policyBasis),
      targetScope: input.targetScope ?? [],
      receiptIds: input.receiptIds ?? [],
    };
  }
}

export function renderOperatorSafetyRecoveryHint(reason: DenialReason | undefined): string {
  if (!reason) {
    return "No recovery action is required.";
  }
  switch (reason.category) {
    case "missing_capability":
      return "Select a capability that covers this tool, or retry with a tool already covered by the selected capability receipt.";
    case "denied_by_policy":
      return "Use another tool or a lower-risk action; runtime policy denies this request.";
    case "sandbox_blocked":
      return "Request an effectful approval path or retry with sandbox evidence that matches the requested action.";
    case "sandbox_failed":
      return "Retry after collecting fresh sandbox execution evidence, or request operator approval for the effectful path.";
    case "sandbox_unavailable":
      return "Collect sandbox availability evidence, then retry or request operator approval for the effectful path.";
    case "sandbox_violated":
      return "Stop relying on the sandbox result, inspect the violation evidence, and request approval before retrying.";
    case "sandbox_wrong_backend":
      return "Retry through the virtual read-only backend, or request effectful approval before using host or box execution evidence.";
    case "approval_cancelled":
      return "Request approval again only if the operation is still required.";
    case "evidence_missing":
      return "Gather the missing manifest, capability, receipt, or sandbox evidence before retrying.";
  }
  return "Gather the missing manifest, capability, receipt, or sandbox evidence before retrying.";
}

function titleCaseDecision(decision: OperatorSafetyDecision): "Allow" | "Ask" | "Deny" {
  switch (decision) {
    case "allow":
      return "Allow";
    case "ask":
      return "Ask";
    case "deny":
      return "Deny";
  }
  return "Ask";
}

export function renderOperatorSafetyDecision(view: OperatorSafetyDecisionView): string {
  const parts = [
    `${titleCaseDecision(view.decision)} ${view.toolName}`,
    `action=${view.actionClass}`,
    `boundary=${view.effectBoundary}`,
  ];
  if (view.manifestBasis) {
    parts.push(`manifestBasis=${view.manifestBasis}`);
  }
  if (view.sandbox) {
    parts.push(`sandbox=${view.sandbox.backend}/${view.sandbox.status}`);
  }
  if (view.capabilityBasis?.receiptId) {
    parts.push(`capabilityReceipt=${view.capabilityBasis.receiptId}`);
  }
  if (view.denialReason) {
    parts.push(`denial=${view.denialReason.category}`);
  }
  return parts.join(" · ");
}
