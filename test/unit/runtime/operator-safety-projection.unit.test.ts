import { describe, expect, test } from "bun:test";
import {
  projectOperatorSafetyDecision,
  renderOperatorSafetyDecision,
  renderOperatorSafetyRecoveryHint,
  type EffectAuthorityManifestBasis,
  type OperatorSafetyDecision,
  type SandboxPosture,
} from "@brewva/brewva-runtime/security";
import fc from "fast-check";

const DECISION_RANK: Record<OperatorSafetyDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

const virtualReadonlyOk: SandboxPosture = {
  backend: "virtual_readonly",
  status: "ok",
  evidenceEventId: "event-exec-started",
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

function manifestBasisFor(
  actionClass: EffectAuthorityManifestBasis["actionClass"],
): EffectAuthorityManifestBasis {
  return {
    ...readonlyExecManifestBasis,
    toolName: actionClass === "workspace_read" ? "read" : "exec",
    actionClass,
    boundary: actionClass === "workspace_read" ? "safe" : "effectful",
    effects: actionClass === "workspace_read" ? ["workspace_read"] : ["local_exec"],
  };
}

describe("operator safety projection", () => {
  test("renders readonly exec as allow only with virtual readonly sandbox evidence", () => {
    const view = projectOperatorSafetyDecision({
      kernelDecision: "allow",
      toolName: "exec",
      actionClass: "local_exec_readonly",
      effectBoundary: "effectful",
      consequencePosture: "observe_only",
      manifestBasis: readonlyExecManifestBasis,
      policyBasis: ["command_policy_and_virtual_readonly_shell_enforced"],
      targetScope: ["workspace"],
      receiptIds: ["event-exec-started"],
      safetyGate: { localExecReadonlyAutoAllow: true },
      sandbox: virtualReadonlyOk,
    });

    expect(view).toMatchObject({
      decision: "allow",
      toolName: "exec",
      actionClass: "local_exec_readonly",
      policyBasis: ["command_policy_and_virtual_readonly_shell_enforced"],
      sandbox: virtualReadonlyOk,
    });
    expect(renderOperatorSafetyDecision(view)).toContain("Allow");
    expect(renderOperatorSafetyDecision(view)).toContain("virtual_readonly");
  });

  test("does not widen kernel ask even when evidence would otherwise satisfy auto-allow", () => {
    const view = projectOperatorSafetyDecision({
      kernelDecision: "ask",
      toolName: "exec",
      actionClass: "local_exec_readonly",
      effectBoundary: "effectful",
      consequencePosture: "observe_only",
      manifestBasis: readonlyExecManifestBasis,
      policyBasis: "command_policy_and_virtual_readonly_shell_enforced",
      targetScope: ["workspace"],
      receiptIds: ["approval:session:call"],
      pendingRequestId: "approval:session:call",
      safetyGate: { localExecReadonlyAutoAllow: true },
      sandbox: virtualReadonlyOk,
    });

    expect(view.decision).toBe("ask");
    expect(view.pendingRequestId).toBe("approval:session:call");
    expect(view.policyBasis).toEqual(["command_policy_and_virtual_readonly_shell_enforced"]);
    expect(renderOperatorSafetyDecision(view)).toContain("Ask");
  });

  test("blocks readonly auto-allow when sandbox evidence is host execution", () => {
    const view = projectOperatorSafetyDecision({
      kernelDecision: "allow",
      toolName: "exec",
      actionClass: "local_exec_readonly",
      effectBoundary: "effectful",
      consequencePosture: "observe_only",
      manifestBasis: readonlyExecManifestBasis,
      policyBasis: ["command_policy_and_virtual_readonly_shell_enforced"],
      targetScope: ["workspace"],
      receiptIds: ["event-host-started"],
      safetyGate: { localExecReadonlyAutoAllow: true },
      sandbox: {
        backend: "host",
        status: "ok",
        evidenceEventId: "event-host-started",
      },
    });

    expect(view).toMatchObject({
      decision: "deny",
      denialReason: {
        category: "sandbox_wrong_backend",
        retryHint: "request_approval",
      },
    });
    expect(renderOperatorSafetyRecoveryHint(view.denialReason)).toContain("effectful approval");
  });

  test("classifies sandbox execution failures separately from boundary blocks", () => {
    const view = projectOperatorSafetyDecision({
      kernelDecision: "allow",
      toolName: "exec",
      actionClass: "local_exec_readonly",
      effectBoundary: "effectful",
      consequencePosture: "observe_only",
      manifestBasis: readonlyExecManifestBasis,
      policyBasis: ["command_policy_and_virtual_readonly_shell_enforced"],
      targetScope: ["workspace"],
      receiptIds: ["event-virtual-readonly-failed"],
      safetyGate: { localExecReadonlyAutoAllow: true },
      sandbox: {
        backend: "virtual_readonly",
        status: "failed",
        evidenceEventId: "event-virtual-readonly-failed",
      },
    });

    expect(view).toMatchObject({
      decision: "deny",
      denialReason: {
        category: "sandbox_failed",
        retryHint: "request_approval",
      },
    });
    expect(renderOperatorSafetyRecoveryHint(view.denialReason)).toContain("fresh sandbox");
  });

  test("fail-closes allow to ask when manifest evidence is missing", () => {
    const view = projectOperatorSafetyDecision({
      kernelDecision: "allow",
      toolName: "exec",
      actionClass: "local_exec_readonly",
      effectBoundary: "effectful",
      consequencePosture: "observe_only",
      policyBasis: ["command_policy_and_virtual_readonly_shell_enforced"],
      targetScope: ["workspace"],
      receiptIds: ["event-exec-started"],
      safetyGate: { localExecReadonlyAutoAllow: true },
      sandbox: virtualReadonlyOk,
    });

    expect(view.decision).toBe("ask");
    expect("denialReason" in view).toBe(false);
    expect(renderOperatorSafetyDecision(view)).toContain("Ask");
    expect(renderOperatorSafetyDecision(view)).not.toContain("denial=");
  });

  test("keeps durable deny when manifest evidence is missing", () => {
    const view = projectOperatorSafetyDecision({
      kernelDecision: "deny",
      toolName: "exec",
      actionClass: "local_exec_readonly",
      effectBoundary: "effectful",
      consequencePosture: "observe_only",
      policyBasis: ["command policy denied readonly exec"],
      targetScope: ["workspace"],
      receiptIds: ["event-policy-denied"],
      kernelReason: "command_policy_denied",
      safetyGate: { localExecReadonlyAutoAllow: true },
      sandbox: virtualReadonlyOk,
    });

    expect(view.decision).toBe("deny");
    expect(view.denialReason).toMatchObject({
      category: "denied_by_policy",
      retryHint: "try_other_tool",
    });
  });

  test("uses the same denial reason for operator text and model-facing recovery hints", () => {
    const view = projectOperatorSafetyDecision({
      kernelDecision: "deny",
      toolName: "mcp__github__create_issue",
      actionClass: "external_side_effect",
      effectBoundary: "effectful",
      consequencePosture: "manual_recovery",
      manifestBasis: {
        ...readonlyExecManifestBasis,
        toolName: "mcp__github__create_issue",
        actionClass: "external_side_effect",
        riskLevel: "high",
        effectiveAdmission: "deny",
        effects: ["external_side_effect"],
        requiresApproval: true,
        recoveryPreparation: "manual",
        commitmentPosture: {
          recoverability: "manual_recovery",
          visibility: "externally_observable",
          evidenceSources: ["action_policy"],
          warnings: [],
        },
      },
      policyBasis: ["selected capability does not cover this tool"],
      targetScope: ["github"],
      receiptIds: ["capability-selection-1"],
      capabilityBasis: {
        allowed: false,
        reason: "missing_selected_capability",
        source: "capability_selection",
        selectedCapabilityNames: ["github-readonly"],
      },
    });

    expect(view.denialReason).toMatchObject({
      category: "missing_capability",
      retryHint: "gather_evidence",
    });
    const operatorText = renderOperatorSafetyDecision(view);
    const recoveryHint = renderOperatorSafetyRecoveryHint(view.denialReason);
    expect(operatorText).toContain("missing_capability");
    expect(recoveryHint).toContain("Select");
    expect(`${operatorText}\n${recoveryHint}`).not.toMatch(/SECRET|TOKEN=|raw command/u);
  });

  test("never widens generated kernel decisions", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("allow", "ask", "deny"),
        fc.constantFrom("workspace_read", "local_exec_readonly", "local_exec_effectful"),
        fc.option(fc.constantFrom<SandboxPosture["backend"]>("virtual_readonly", "box", "host"), {
          nil: undefined,
        }),
        (kernelDecision, actionClass, backend) => {
          const view = projectOperatorSafetyDecision({
            kernelDecision,
            toolName: actionClass === "workspace_read" ? "read" : "exec",
            actionClass,
            effectBoundary: actionClass === "workspace_read" ? "safe" : "effectful",
            consequencePosture: "observe_only",
            manifestBasis: manifestBasisFor(actionClass),
            policyBasis: [],
            targetScope: [],
            receiptIds: [],
            safetyGate: { localExecReadonlyAutoAllow: true },
            sandbox: backend
              ? {
                  backend,
                  status: "ok",
                }
              : undefined,
          });
          expect(DECISION_RANK[view.decision]).toBeGreaterThanOrEqual(
            DECISION_RANK[kernelDecision],
          );
        },
      ),
      { seed: 0x5afe2026, numRuns: 100 },
    );
  });
});
