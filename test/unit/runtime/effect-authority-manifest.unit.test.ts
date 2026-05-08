import { describe, expect, test } from "bun:test";
import {
  buildEffectAuthorityManifestBasis,
  decideEffectAuthorityManifest,
  type EffectAuthorityManifestFacts,
} from "@brewva/brewva-runtime";

function baseFacts(
  overrides: Partial<EffectAuthorityManifestFacts> = {},
): EffectAuthorityManifestFacts {
  return {
    toolName: "write",
    boundary: "effectful",
    authoritySource: "exact",
    actionClass: "workspace_patch",
    riskLevel: "high",
    effectiveAdmission: "allow",
    effects: ["workspace_write"],
    requiresApproval: false,
    rollbackable: true,
    receiptPolicy: { kind: "mutation", required: true },
    recoveryPolicy: { kind: "exact_patch", strategy: "workspace_patchset" },
    controlPlaneTool: false,
    skillAccess: { allowed: true, basis: "skill_effect_contract" },
    repairAccess: { allowed: true, basis: "repair_posture" },
    budgetAccess: { allowed: true, basis: "session_budget" },
    routingAccess: { allowed: true, basis: "routing_scope" },
    boundaryAccess: { allowed: true, basis: "boundary_policy" },
    deduplicationAccess: { allowed: true, basis: "exact_call_loop" },
    capabilityAccess: { allowed: true, basis: "runtime_capability_scope" },
    ...overrides,
  };
}

describe("effect authority manifest", () => {
  test("fails closed when exact action policy authority is missing", () => {
    const decision = decideEffectAuthorityManifest(
      baseFacts({
        authoritySource: "hint",
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toBe("Tool 'write' requires an exact action policy.");
    expect(decision.manifestBasis.invariantBasis).toContain("exact_action_policy_required");
    expect(decision.manifestBasis.authoritySource).toBe("hint");
  });

  test("control-plane status cannot override invariant authority requirements", () => {
    const decision = decideEffectAuthorityManifest(
      baseFacts({
        toolName: "reasoning_revert",
        actionClass: "control_state_mutation",
        authoritySource: "missing",
        controlPlaneTool: true,
        skillAccess: {
          allowed: false,
          basis: "skill_effect_contract",
          reason: "skill_effect_contract_denied",
        },
        budgetAccess: {
          allowed: false,
          basis: "session_budget",
          reason: "session_budget_exceeded",
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("Tool 'reasoning_revert' requires an exact action policy.");
    expect(decision.manifestBasis.invariantBasis).toContain("exact_action_policy_required");
    expect(decision.manifestBasis.overlayBasis).toContain("control_plane_tool");
  });

  test("capability denials render as runtime denials without becoming action policy rows", () => {
    const decision = decideEffectAuthorityManifest(
      baseFacts({
        capabilityAccess: {
          allowed: false,
          basis: "runtime_capability_scope",
          reason: "runtime_capability_undeclared:events.write",
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("runtime_capability_undeclared:events.write");
    expect(decision.manifestBasis.actionClass).toBe("workspace_patch");
    expect(decision.manifestBasis.runtimeBasis).toContain("runtime_capability_scope");
    expect(decision.manifestBasis.invariantBasis).toContain("exact_action_policy_required");
  });

  test("removed shell tools are represented by action policy facts, not manifest tool-name rules", () => {
    const decision = decideEffectAuthorityManifest(
      baseFacts({
        toolName: "shell",
        actionClass: "local_exec_effectful",
        riskLevel: "critical",
        effectiveAdmission: "deny",
        effects: ["local_exec"],
        rollbackable: false,
        receiptPolicy: { kind: "security_audit", required: true },
        recoveryPolicy: { kind: "none" },
        policyBasis: ["removed_shell_tools_disabled"],
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("Tool 'shell' is denied by action admission policy.");
    expect(decision.manifestBasis.invariantBasis).toEqual(["exact_action_policy_required"]);
    expect(decision.manifestBasis.overlayBasis).toContain("removed_shell_tools_disabled");
  });

  test("readonly local exec auto-allow is anchored as an invariant safety gate", () => {
    const basis = buildEffectAuthorityManifestBasis(
      baseFacts({
        toolName: "exec",
        actionClass: "local_exec_readonly",
        riskLevel: "low",
        effects: ["local_exec"],
        rollbackable: false,
        receiptPolicy: { kind: "audit", required: false },
        recoveryPolicy: { kind: "none" },
        commandPolicy: {
          readonlyEligible: true,
          commands: ["cat"],
          effects: [],
          filesystemIntent: "read",
          unsupportedReasons: [],
          networkTargets: [],
        },
        virtualReadonly: {
          readonlyGrammarEligible: true,
          eligible: true,
          materializedCandidates: ["package.json"],
          blockedReasons: [],
        },
      }),
    );

    expect(basis.invariantBasis).toContain("local_exec_readonly_virtual_route_required");
    expect(basis.runtimeBasis).toContain("command_policy");
    expect(basis.runtimeBasis).toContain("virtual_readonly_policy");
  });

  test("readonly local exec blocks without a virtual readonly route", () => {
    const decision = decideEffectAuthorityManifest(
      baseFacts({
        toolName: "exec",
        actionClass: "local_exec_readonly",
        riskLevel: "low",
        effects: ["local_exec"],
        rollbackable: false,
        receiptPolicy: { kind: "audit", required: false },
        recoveryPolicy: { kind: "none" },
        commandPolicy: {
          readonlyEligible: true,
          commands: ["cat"],
          effects: [],
          filesystemIntent: "read",
          unsupportedReasons: [],
          networkTargets: [],
        },
        virtualReadonly: {
          readonlyGrammarEligible: true,
          eligible: false,
          materializedCandidates: [],
          blockedReasons: [{ code: "outside_workspace" }],
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("local_exec_readonly requires a virtual readonly route");
    expect(decision.manifestBasis.runtimeBasis).toContain("local_exec_readonly_virtual_route");
  });

  test("readonly local exec blocks when command and virtual readonly facts are absent", () => {
    const decision = decideEffectAuthorityManifest(
      baseFacts({
        toolName: "exec",
        actionClass: "local_exec_readonly",
        riskLevel: "low",
        effects: ["local_exec"],
        rollbackable: false,
        receiptPolicy: { kind: "audit", required: false },
        recoveryPolicy: { kind: "none" },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("local_exec_readonly requires command policy analysis.");
    expect(decision.manifestBasis.invariantBasis).toContain(
      "local_exec_readonly_virtual_route_required",
    );
    expect(decision.manifestBasis.runtimeBasis).toContain("local_exec_readonly_virtual_route");
    expect(decision.manifestBasis.runtimeBasis).not.toContain("command_policy");
    expect(decision.manifestBasis.runtimeBasis).not.toContain("virtual_readonly_policy");
  });
});
