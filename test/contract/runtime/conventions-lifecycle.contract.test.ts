import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, type ConventionChangeRequest } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function evidence(id: string) {
  return {
    id,
    sourceType: "claim" as const,
    locator: `claim://${id}`,
    createdAt: 1,
    sessionId: "session-evidence",
    modelVersion: "model-a",
    toolVersion: "tool-a",
    originatingRuleIds: ["rule-a"],
    scope: "project",
    trustLevel: "observed" as const,
    polarity: "support" as const,
  };
}

describe("convention lifecycle governance", () => {
  test("observations auto-accept and rebuild convention state from tape", () => {
    const workspace = createTestWorkspace("convention-observation");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `convention-observation-${crypto.randomUUID()}`;

    const receipt = runtime.authority.conventions.submitChangeRequest(sessionId, {
      id: "convention-observe-1",
      issuer: "unit-test",
      subject: "Prefer explicit verification commands",
      conventionKind: "style_rule",
      transition: "observe",
      target: {
        kind: "project_guidance",
        path: "skills/project/shared/verification-style.md",
      },
      evidenceRefs: [evidence("evidence-observe-1")],
      rationale: "Repeated project guidance observations.",
      createdAt: 1,
    });

    expect(receipt.decision).toBe("accept");
    expect(receipt.reviewSurface).toBe("digest");
    expect(runtime.inspect.conventions.getState(sessionId).activeConventions).toHaveLength(1);
    expect(
      runtime.inspect.events.query(sessionId, {
        type: "convention_candidate_observed",
      }),
    ).toHaveLength(1);
  });

  test("approved convention mutation records a convention mutation receipt and rollback candidate", () => {
    const workspace = createTestWorkspace("convention-apply");
    mkdirSync(join(workspace, ".brewva/artifacts"), { recursive: true });
    mkdirSync(join(workspace, "skills/project/shared"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/artifacts/new-guidance.md"),
      [
        "---",
        "strength: workflow_gate",
        "scope: convention-test",
        "convention_kind: workflow_rule",
        "retirement_sensitivity: review_only",
        "---",
        "# Convention Test",
        "",
        "- run explicit verification.",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `convention-apply-${crypto.randomUUID()}`;
    const request: ConventionChangeRequest = {
      id: "convention-apply-1",
      issuer: "unit-test",
      subject: "Add verification workflow guidance",
      conventionKind: "workflow_rule",
      transition: "promote",
      target: {
        kind: "project_guidance",
        path: "skills/project/shared/new-guidance.md",
      },
      evidenceRefs: [evidence("evidence-apply-1")],
      rationale: "Promote repeated verification guidance.",
      blastRadius: "project",
      patchSet: {
        id: "patchset-convention-1",
        createdAt: 1,
        changes: [
          {
            path: "skills/project/shared/new-guidance.md",
            action: "add",
            artifactRef: ".brewva/artifacts/new-guidance.md",
          },
        ],
      },
      createdAt: 1,
    };

    const submitted = runtime.authority.conventions.submitChangeRequest(sessionId, request);
    expect(submitted.decision).toBe("defer");
    expect(submitted.reviewSurface).toBe("digest");
    expect(runtime.inspect.conventions.listPending(sessionId)).toHaveLength(1);

    const decided = runtime.authority.conventions.decideChangeRequest(sessionId, request.id, {
      decision: "accept",
      actor: "operator",
      reason: "explicit_operator_decision",
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error("expected convention decision to pass");
    expect(decided.receipt.reviewSurface).toBe("audit");
    expect(runtime.inspect.conventions.getState(sessionId).activeConventions).toHaveLength(0);

    const applied = runtime.authority.conventions.applyApprovedChange(sessionId, request.id);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("expected convention apply to pass");
    const activeConventions = runtime.inspect.conventions.getState(sessionId).activeConventions;
    expect(activeConventions).toHaveLength(1);
    expect(activeConventions[0]?.transition).toBe("promote");

    const targetPath = join(workspace, "skills/project/shared/new-guidance.md");
    expect(readFileSync(targetPath, "utf8")).toContain("Convention Test");

    const mutationEvent = runtime.inspect.events.query(sessionId, {
      type: "reversible_mutation_recorded",
      last: 1,
    })[0];
    const mutationPayload = mutationEvent?.payload as
      | { receipt?: { subject?: { kind?: string } } }
      | undefined;
    expect(mutationPayload?.receipt?.subject?.kind).toBe("convention");

    const rollback = runtime.authority.tools.rollbackLastMutation(sessionId);
    expect(rollback.ok).toBe(true);
    if (!rollback.ok) throw new Error("expected convention rollback to pass");
    expect(rollback.subject?.kind).toBe("convention");
    expect(existsSync(targetPath)).toBe(false);
  });

  test("pinned convention mutations require explicit operator decision before apply", () => {
    const workspace = createTestWorkspace("convention-pinned");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `convention-pinned-${crypto.randomUUID()}`;

    const request: ConventionChangeRequest = {
      id: "convention-pinned-1",
      issuer: "unit-test",
      subject: "Relax a safety boundary",
      conventionKind: "safety_boundary",
      transition: "modify",
      target: {
        kind: "runtime_config",
        path: ".brewva/config.json",
        configPaths: ["security.actionAdmissionOverrides.local_exec_effectful"],
      },
      evidenceRefs: [evidence("evidence-pinned-1")],
      rationale: "Pinned relaxation must interrupt.",
      blastRadius: "security_boundary",
      patchSet: {
        id: "patchset-pinned-1",
        createdAt: 1,
        changes: [
          {
            path: ".brewva/config.json",
            action: "add",
            artifactRef: ".brewva/artifacts/config.json",
          },
        ],
      },
      createdAt: 1,
    };

    const receipt = runtime.authority.conventions.submitChangeRequest(sessionId, request);
    expect(receipt.decision).toBe("defer");
    expect(receipt.lane).toBe("pinned");
    expect(receipt.reviewSurface).toBe("interrupt");

    const applied = runtime.authority.conventions.applyApprovedChange(sessionId, request.id);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe("request_not_accepted");
    }
  });

  test("terminal rejected and expired requests are routed to audit", () => {
    const workspace = createTestWorkspace("convention-terminal-audit");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `convention-terminal-audit-${crypto.randomUUID()}`;

    const expired = runtime.authority.conventions.submitChangeRequest(sessionId, {
      id: "convention-expired-1",
      issuer: "unit-test",
      subject: "Expired workflow rule",
      conventionKind: "workflow_rule",
      transition: "promote",
      target: {
        kind: "project_guidance",
        path: "skills/project/shared/expired.md",
      },
      evidenceRefs: [evidence("evidence-expired-1")],
      rationale: "Expired requests should not stay on the review desk.",
      expiresAt: 1,
      createdAt: 1,
    });

    expect(expired.decision).toBe("reject");
    expect(expired.reviewSurface).toBe("audit");
  });

  test("rejected observations and contests do not emit accepted-only side events", () => {
    const workspace = createTestWorkspace("convention-rejected-side-events");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `convention-rejected-side-events-${crypto.randomUUID()}`;
    const target = {
      kind: "project_guidance" as const,
      path: "skills/project/shared/rejected.md",
    };

    const observation = runtime.authority.conventions.submitChangeRequest(sessionId, {
      id: "convention-rejected-observe-1",
      issuer: "unit-test",
      subject: "Rejected observation",
      conventionKind: "style_rule",
      transition: "observe",
      target,
      evidenceRefs: [],
      rationale: "Missing evidence should reject before observation side effects.",
      createdAt: 1,
    });
    const contest = runtime.authority.conventions.submitChangeRequest(sessionId, {
      id: "convention-rejected-contest-1",
      issuer: "unit-test",
      subject: "Rejected contest",
      conventionKind: "style_rule",
      transition: "contest",
      target,
      evidenceRefs: [],
      rationale: "Missing evidence should reject before contest side effects.",
      createdAt: 2,
    });

    expect(observation.decision).toBe("reject");
    expect(contest.decision).toBe("reject");
    expect(
      runtime.inspect.events.query(sessionId, {
        type: "convention_candidate_observed",
      }),
    ).toHaveLength(0);
    expect(
      runtime.inspect.events.query(sessionId, {
        type: "convention_contested",
      }),
    ).toHaveLength(0);
    const state = runtime.inspect.conventions.getState(sessionId);
    expect(state.activeConventions).toHaveLength(0);
    expect(state.contestedRequestIds).toEqual([]);
  });

  test("contest requests do not become active and consumed retire removes active convention", () => {
    const workspace = createTestWorkspace("convention-retire-state");
    mkdirSync(join(workspace, "skills/project/shared"), { recursive: true });
    writeFileSync(
      join(workspace, "skills/project/shared/retire-me.md"),
      [
        "---",
        "strength: workflow_gate",
        "scope: convention-test",
        "convention_kind: style_rule",
        "retirement_sensitivity: auto_decay_allowed",
        "---",
        "# Retire Me",
        "",
        "- temporary convention.",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `convention-retire-state-${crypto.randomUUID()}`;
    const target = {
      kind: "project_guidance" as const,
      path: "skills/project/shared/retire-me.md",
    };

    runtime.authority.conventions.submitChangeRequest(sessionId, {
      id: "convention-observe-retire-1",
      issuer: "unit-test",
      subject: "Temporary convention",
      conventionKind: "style_rule",
      transition: "observe",
      target,
      evidenceRefs: [evidence("evidence-retire-observe-1")],
      rationale: "A soft observation should become active.",
      createdAt: 1,
    });

    const contest = runtime.authority.conventions.submitChangeRequest(sessionId, {
      id: "convention-contest-retire-1",
      issuer: "unit-test",
      subject: "Contest temporary convention",
      conventionKind: "style_rule",
      transition: "contest",
      target,
      evidenceRefs: [evidence("evidence-retire-contest-1")],
      rationale: "Contest should be inspectable but not active.",
      createdAt: 2,
    });

    expect(contest.decision).toBe("accept");
    expect(contest.reviewSurface).toBe("audit");
    expect(runtime.inspect.conventions.getState(sessionId).activeConventions).toHaveLength(1);
    expect(runtime.inspect.conventions.getState(sessionId).contestedRequestIds).toEqual([
      "convention-contest-retire-1",
    ]);

    const retireRequest: ConventionChangeRequest = {
      id: "convention-retire-1",
      issuer: "unit-test",
      subject: "Retire temporary convention",
      conventionKind: "style_rule",
      transition: "retire",
      target,
      evidenceRefs: [evidence("evidence-retire-1")],
      rationale: "Retire should remove the active convention after approved application.",
      patchSet: {
        id: "patchset-retire-1",
        createdAt: 3,
        changes: [
          {
            path: "skills/project/shared/retire-me.md",
            action: "delete",
          },
        ],
      },
      createdAt: 3,
    };

    const submitted = runtime.authority.conventions.submitChangeRequest(sessionId, retireRequest);
    expect(submitted.decision).toBe("defer");
    expect(runtime.inspect.conventions.getState(sessionId).activeConventions).toHaveLength(1);

    const decided = runtime.authority.conventions.decideChangeRequest(sessionId, retireRequest.id, {
      decision: "accept",
      actor: "operator",
      reason: "explicit_operator_decision",
    });
    expect(decided.ok).toBe(true);
    expect(runtime.inspect.conventions.getState(sessionId).activeConventions).toHaveLength(1);

    const applied = runtime.authority.conventions.applyApprovedChange(sessionId, retireRequest.id);
    expect(applied.ok).toBe(true);
    expect(runtime.inspect.conventions.getState(sessionId).activeConventions).toHaveLength(0);
  });

  test("runtime_config target writer rejects non-config files even for allowed config paths", () => {
    const workspace = createTestWorkspace("convention-runtime-target");
    mkdirSync(join(workspace, ".brewva/artifacts"), { recursive: true });
    writeFileSync(join(workspace, ".brewva/artifacts/readme.md"), "# Invalid\n", "utf8");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `convention-runtime-target-${crypto.randomUUID()}`;
    const request: ConventionChangeRequest = {
      id: "convention-runtime-target-1",
      issuer: "unit-test",
      subject: "Invalid runtime config target",
      conventionKind: "verification_rule",
      transition: "modify",
      target: {
        kind: "runtime_config",
        path: "README.md",
        configPaths: ["verification.requiredCommands"],
      },
      evidenceRefs: [evidence("evidence-runtime-target-1")],
      rationale: "Runtime config changes must be limited to registered config files.",
      patchSet: {
        id: "patchset-runtime-target-1",
        createdAt: 1,
        changes: [
          {
            path: "README.md",
            action: "add",
            artifactRef: ".brewva/artifacts/readme.md",
          },
        ],
      },
      createdAt: 1,
    };

    const submitted = runtime.authority.conventions.submitChangeRequest(sessionId, request);
    expect(submitted.decision).toBe("defer");
    const decided = runtime.authority.conventions.decideChangeRequest(sessionId, request.id, {
      decision: "accept",
      actor: "operator",
      reason: "explicit_operator_decision",
    });
    expect(decided.ok).toBe(true);

    const applied = runtime.authority.conventions.applyApprovedChange(sessionId, request.id);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe("invalid_target");
    }
    expect(existsSync(join(workspace, "README.md"))).toBe(false);
  });

  test("target writers reject same-class patch paths that do not match the request target", () => {
    const workspace = createTestWorkspace("convention-target-path-match");
    mkdirSync(join(workspace, ".brewva/artifacts"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/artifacts/other-guidance.md"),
      [
        "---",
        "strength: workflow_gate",
        "scope: convention-test",
        "convention_kind: workflow_rule",
        "retirement_sensitivity: review_only",
        "---",
        "# Other Guidance",
      ].join("\n"),
      "utf8",
    );
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `convention-target-path-match-${crypto.randomUUID()}`;

    const projectGuidanceRequest: ConventionChangeRequest = {
      id: "convention-target-path-project-1",
      issuer: "unit-test",
      subject: "Reject mismatched project guidance target",
      conventionKind: "workflow_rule",
      transition: "promote",
      target: {
        kind: "project_guidance",
        path: "skills/project/shared/target-guidance.md",
      },
      evidenceRefs: [evidence("evidence-target-path-project-1")],
      rationale: "A request may only write its declared guidance file.",
      patchSet: {
        id: "patchset-target-path-project-1",
        createdAt: 1,
        changes: [
          {
            path: "skills/project/shared/other-guidance.md",
            action: "add",
            artifactRef: ".brewva/artifacts/other-guidance.md",
          },
        ],
      },
      createdAt: 1,
    };
    runtime.authority.conventions.submitChangeRequest(sessionId, projectGuidanceRequest);
    runtime.authority.conventions.decideChangeRequest(sessionId, projectGuidanceRequest.id, {
      decision: "accept",
      actor: "operator",
      reason: "explicit_operator_decision",
    });
    const projectApply = runtime.authority.conventions.applyApprovedChange(
      sessionId,
      projectGuidanceRequest.id,
    );
    expect(projectApply.ok).toBe(false);
    if (!projectApply.ok) {
      expect(projectApply.reason).toBe("invalid_target");
    }
    expect(existsSync(join(workspace, "skills/project/shared/other-guidance.md"))).toBe(false);

    const skillContractRequest: ConventionChangeRequest = {
      id: "convention-target-path-skill-1",
      issuer: "unit-test",
      subject: "Reject mismatched skill contract target",
      conventionKind: "workflow_rule",
      transition: "modify",
      target: {
        kind: "skill_contract",
        path: "skills/domain/target/SKILL.md",
      },
      evidenceRefs: [evidence("evidence-target-path-skill-1")],
      rationale: "A request may only write its declared skill contract.",
      patchSet: {
        id: "patchset-target-path-skill-1",
        createdAt: 2,
        changes: [
          {
            path: "skills/domain/other/SKILL.md",
            action: "add",
            artifactRef: ".brewva/artifacts/other-guidance.md",
          },
        ],
      },
      createdAt: 2,
    };
    runtime.authority.conventions.submitChangeRequest(sessionId, skillContractRequest);
    runtime.authority.conventions.decideChangeRequest(sessionId, skillContractRequest.id, {
      decision: "accept",
      actor: "operator",
      reason: "explicit_operator_decision",
    });
    const skillApply = runtime.authority.conventions.applyApprovedChange(
      sessionId,
      skillContractRequest.id,
    );
    expect(skillApply.ok).toBe(false);
    if (!skillApply.ok) {
      expect(skillApply.reason).toBe("invalid_target");
    }
    expect(existsSync(join(workspace, "skills/domain/other/SKILL.md"))).toBe(false);
  });
});
