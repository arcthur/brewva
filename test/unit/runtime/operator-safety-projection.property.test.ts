import { expect } from "bun:test";
import {
  projectOperatorSafetyDecision,
  type EffectAuthorityManifestBasis,
  type OperatorSafetyDecision,
  type SandboxPosture,
  type ToolActionClass,
} from "@brewva/brewva-runtime/security";
import fc, { type Arbitrary } from "fast-check";
import { propertyTest } from "../../helpers/property.js";

const DECISION_RANK: Record<OperatorSafetyDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

const readonlyExecManifestBasis: EffectAuthorityManifestBasis = {
  schema: "brewva.effect_authority_basis.v2",
  toolName: "exec",
  boundary: "effectful",
  authoritySource: "action_policy",
  actionClass: "local_exec_readonly",
  riskLevel: "low",
  effectiveAdmission: "allow",
  effects: ["local_exec"],
  requiresApproval: false,
  recoveryPreparation: "none",
  commitmentPosture: {
    recoverability: "observe_only",
    visibility: "local_only",
    evidenceSources: ["action_policy"],
    warnings: [],
  },
  receiptRequired: true,
  invariantBasis: ["kernel_action_policy"],
  overlayBasis: ["command_policy_and_virtual_readonly_shell_enforced"],
  runtimeBasis: ["authority_source:action_policy", "boundary:effectful", "approval_not_required"],
  receiptBasis: ["receipt_policy:execution", "receipt_required"],
};

function manifestBasisFor(actionClass: ToolActionClass): EffectAuthorityManifestBasis {
  const workspaceRead = actionClass === "workspace_read";
  return {
    ...readonlyExecManifestBasis,
    toolName: workspaceRead ? "read" : "exec",
    actionClass,
    boundary: workspaceRead ? "safe" : "effectful",
    effects: workspaceRead ? ["workspace_read"] : ["local_exec"],
    requiresApproval: actionClass !== "workspace_read",
    commitmentPosture: {
      recoverability: workspaceRead ? "observe_only" : "manual_recovery",
      visibility: workspaceRead ? "workspace_visible" : "local_only",
      evidenceSources: ["action_policy"],
      warnings: [],
    },
  };
}

const actionClassArbitrary = fc.constantFrom<ToolActionClass>(
  "workspace_read",
  "local_exec_readonly",
  "local_exec_effectful",
  "external_side_effect",
);

const sandboxArbitrary: Arbitrary<SandboxPosture | undefined> = fc.option(
  fc.record({
    backend: fc.constantFrom<SandboxPosture["backend"]>("virtual_readonly", "box", "host"),
    status: fc.constantFrom<SandboxPosture["status"]>(
      "ok",
      "unavailable",
      "blocked",
      "violated",
      "failed",
    ),
  }),
  { nil: undefined },
);

propertyTest<
  [
    OperatorSafetyDecision,
    ToolActionClass,
    SandboxPosture | undefined,
    boolean,
    "allowed" | "missing" | "absent",
  ]
>("operator safety decision view never widens kernel admission", {
  propertyId: "runtime.operator_safety.no_widening",
  layer: "unit",
  arbitraries: [
    fc.constantFrom<OperatorSafetyDecision>("allow", "ask", "deny"),
    actionClassArbitrary,
    sandboxArbitrary,
    fc.boolean(),
    fc.constantFrom<"allowed" | "missing" | "absent">("allowed", "missing", "absent"),
  ],
  examples: [["allow", "local_exec_readonly", { backend: "host", status: "ok" }, true, "absent"]],
  predicate(kernelDecision, actionClass, sandbox, includeManifest, capabilityState) {
    const view = projectOperatorSafetyDecision({
      kernelDecision,
      toolName: actionClass === "workspace_read" ? "read" : "exec",
      actionClass,
      effectBoundary: actionClass === "workspace_read" ? "safe" : "effectful",
      consequencePosture: "observe_only",
      ...(includeManifest ? { manifestBasis: manifestBasisFor(actionClass) } : {}),
      policyBasis: [],
      targetScope: [],
      receiptIds: capabilityState === "missing" ? ["capability-selection-1"] : [],
      safetyGate: { localExecReadonlyAutoAllow: true },
      ...(capabilityState === "absent"
        ? {}
        : {
            capabilityBasis: {
              allowed: capabilityState === "allowed",
              ...(capabilityState === "missing" ? { receiptId: "capability-selection-1" } : {}),
              source: "capability_selection",
              reason: capabilityState === "missing" ? "missing_selected_capability" : "selected",
            },
          }),
      ...(sandbox ? { sandbox } : {}),
      ...(kernelDecision === "deny" ? { kernelReason: "generated_policy_denied" } : {}),
    });

    expect(DECISION_RANK[view.decision]).toBeGreaterThanOrEqual(DECISION_RANK[kernelDecision]);
  },
});
