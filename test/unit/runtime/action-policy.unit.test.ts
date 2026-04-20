import { describe, expect, test } from "bun:test";
import {
  TOOL_ACTION_POLICY_BY_NAME,
  deriveToolGovernanceDescriptor,
  getExactToolActionPolicy,
  getToolActionPolicy,
  resolveEffectiveToolActionPolicy,
  sameToolActionPolicy,
  toolActionPolicyCreatesRollbackAnchor,
  validateToolActionPolicy,
  type ToolActionPolicy,
} from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";

describe("tool action policy", () => {
  test("derives execution descriptors from semantic action policy", () => {
    const policy = requireDefined(TOOL_ACTION_POLICY_BY_NAME.write, "missing write policy");

    expect(policy).toMatchObject({
      actionClass: "workspace_patch",
      riskLevel: "high",
      defaultAdmission: "allow",
      receiptPolicy: { kind: "mutation", required: true },
      recoveryPolicy: { kind: "exact_patch", strategy: "workspace_patchset" },
    });
    expect(deriveToolGovernanceDescriptor(policy)).toEqual({
      effects: ["workspace_write"],
      defaultRisk: "high",
      boundary: "effectful",
    });
    expect(toolActionPolicyCreatesRollbackAnchor(policy)).toBe(true);
  });

  test("budget mutation uses compensation instead of rollback", () => {
    const policy = requireDefined(
      TOOL_ACTION_POLICY_BY_NAME.resource_lease,
      "missing resource_lease policy",
    );

    expect(policy).toMatchObject({
      actionClass: "budget_mutation",
      receiptPolicy: { kind: "control_plane", required: true },
      recoveryPolicy: { kind: "compensation", mode: "async_cancel" },
    });
    expect(deriveToolGovernanceDescriptor(policy)).toEqual({
      effects: ["budget_mutation"],
      defaultRisk: "medium",
      boundary: "effectful",
      rollbackable: false,
    });
    expect(toolActionPolicyCreatesRollbackAnchor(policy)).toBe(false);
  });

  test("delegation recovery applies only to parent delegation action", () => {
    const policy = requireDefined(
      TOOL_ACTION_POLICY_BY_NAME.subagent_run,
      "missing subagent_run policy",
    );

    expect(policy).toMatchObject({
      actionClass: "delegation",
      receiptPolicy: { kind: "delegation", required: true },
      recoveryPolicy: { kind: "none", scope: "parent_delegation" },
    });
    expect(toolActionPolicyCreatesRollbackAnchor(policy)).toBe(false);
  });

  test("control-plane mutation and delegation derive effectful execution descriptors", () => {
    const controlPolicy = requireDefined(
      TOOL_ACTION_POLICY_BY_NAME.session_compact,
      "missing session_compact policy",
    );
    const delegationPolicy = requireDefined(
      TOOL_ACTION_POLICY_BY_NAME.subagent_run,
      "missing subagent_run policy",
    );

    expect(deriveToolGovernanceDescriptor(controlPolicy)).toEqual({
      effects: ["control_state_mutation"],
      defaultRisk: "medium",
      boundary: "effectful",
      rollbackable: false,
    });
    expect(deriveToolGovernanceDescriptor(delegationPolicy)).toEqual({
      effects: ["delegation"],
      defaultRisk: "medium",
      boundary: "effectful",
      rollbackable: false,
    });
  });

  test("tape handoff is a control-plane mutation because it records durable handoff state", () => {
    const policy = requireDefined(
      TOOL_ACTION_POLICY_BY_NAME.tape_handoff,
      "missing tape_handoff policy",
    );

    expect(policy).toMatchObject({
      actionClass: "control_state_mutation",
      riskLevel: "medium",
      receiptPolicy: { kind: "control_plane", required: true },
      recoveryPolicy: { kind: "forward_correction" },
      effectClasses: ["control_state_mutation"],
    });
    expect(deriveToolGovernanceDescriptor(policy)).toEqual({
      effects: ["control_state_mutation"],
      defaultRisk: "medium",
      boundary: "effectful",
      rollbackable: false,
    });
  });

  test("rejects critical action policy that can be relaxed below ask", () => {
    const unsafePolicy: ToolActionPolicy = {
      actionClass: "credential_access",
      riskLevel: "critical",
      defaultAdmission: "ask",
      maxAdmission: "allow",
      receiptPolicy: { kind: "security_audit", required: true },
      recoveryPolicy: { kind: "none" },
      effectClasses: ["credential_access"],
    };

    expect(() => validateToolActionPolicy("credential_probe", unsafePolicy)).toThrow(
      "critical action policy cannot be relaxed below ask",
    );
  });

  test("built-in exact action policies are validated before exposure", () => {
    const original = requireDefined(TOOL_ACTION_POLICY_BY_NAME.exec, "missing exec policy");
    TOOL_ACTION_POLICY_BY_NAME.exec = {
      ...original,
      riskLevel: "critical",
      maxAdmission: "allow",
    };

    try {
      expect(() => getExactToolActionPolicy("exec")).toThrow(
        "critical action policy cannot be relaxed below ask",
      );
      expect(() => getToolActionPolicy("exec")).toThrow(
        "critical action policy cannot be relaxed below ask",
      );
    } finally {
      TOOL_ACTION_POLICY_BY_NAME.exec = original;
    }
  });

  test("operator overrides can tighten but cannot exceed max admission", () => {
    const policy = requireDefined(TOOL_ACTION_POLICY_BY_NAME.exec, "missing exec policy");

    expect(resolveEffectiveToolActionPolicy(policy, "deny").effectiveAdmission).toBe("deny");
    expect(resolveEffectiveToolActionPolicy(policy, "allow").effectiveAdmission).toBe("ask");
  });

  test("local exec read-only policy cannot auto-allow before the safety gate exists", () => {
    const policy = requireDefined(
      TOOL_ACTION_POLICY_BY_NAME.local_exec_readonly,
      "missing local_exec_readonly policy",
    );

    expect(policy.actionClass).toBe("local_exec_readonly");
    expect(policy.defaultAdmission).toBe("ask");
    expect(policy.safetyGate).toEqual({
      localExecReadonlyAutoAllow: false,
      reason: "command_policy_and_sandbox_not_implemented",
    });
  });

  test("tool action policy equality is order-stable and covers execution metadata", () => {
    const left: ToolActionPolicy = {
      actionClass: "local_exec_effectful",
      riskLevel: "high",
      defaultAdmission: "ask",
      maxAdmission: "ask",
      receiptPolicy: { kind: "commitment", required: true },
      recoveryPolicy: { kind: "compensation", mode: "manual" },
      effectClasses: ["local_exec"],
      sandboxPolicy: { kind: "host_effect" },
      budgetWeight: 2,
      safetyGate: {
        localExecReadonlyAutoAllow: false,
        reason: "command_policy_and_sandbox_not_implemented",
      },
    };
    const sameWithDifferentKeyOrder: ToolActionPolicy = {
      actionClass: "local_exec_effectful",
      riskLevel: "high",
      defaultAdmission: "ask",
      maxAdmission: "ask",
      receiptPolicy: { required: true, kind: "commitment" },
      recoveryPolicy: { mode: "manual", kind: "compensation" },
      effectClasses: ["local_exec"],
      sandboxPolicy: { kind: "host_effect" },
      budgetWeight: 2,
      safetyGate: {
        reason: "command_policy_and_sandbox_not_implemented",
        localExecReadonlyAutoAllow: false,
      },
    };

    expect(sameToolActionPolicy(left, sameWithDifferentKeyOrder)).toBe(true);
    expect(
      sameToolActionPolicy(left, {
        ...sameWithDifferentKeyOrder,
        sandboxPolicy: { kind: "sandbox_required" },
      }),
    ).toBe(false);
    expect(
      sameToolActionPolicy(left, {
        ...sameWithDifferentKeyOrder,
        budgetWeight: 3,
      }),
    ).toBe(false);
    expect(
      sameToolActionPolicy(left, {
        ...sameWithDifferentKeyOrder,
        safetyGate: { localExecReadonlyAutoAllow: true },
      }),
    ).toBe(false);
  });
});
