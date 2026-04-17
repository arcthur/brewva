import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { buildCanonicalReviewReport } from "../../helpers/semantic-artifacts.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

let workspace = "";

type SkillFixtureInput = {
  name: string;
  outputs: string[];
  semanticBindings?: Record<string, string>;
  consumes?: string[];
  requires?: string[];
};

function writeSkill(filePath: string, input: SkillFixtureInput): void {
  const unboundOutputs = input.outputs.filter(
    (outputName) => !input.semanticBindings || !input.semanticBindings[outputName],
  );
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.name} skill`,
      "selection:",
      "  when_to_use: Use when the task needs the routed test skill.",
      "  examples: [test skill]",
      "  phases: [align]",
      "intent:",
      `  outputs: [${input.outputs.join(", ")}]`,
      ...(input.semanticBindings && Object.keys(input.semanticBindings).length > 0
        ? [
            "  semantic_bindings:",
            ...Object.entries(input.semanticBindings).map(([outputName, schemaId]) => [
              `    ${outputName}: ${schemaId}`,
            ]),
          ].flat()
        : []),
      ...(unboundOutputs.length > 0
        ? [
            "  output_contracts:",
            ...unboundOutputs.flatMap((outputName) => [
              `    ${outputName}:`,
              "      kind: text",
              "      min_length: 1",
            ]),
          ]
        : []),
      "effects:",
      "  allowed_effects: [workspace_read]",
      "resources:",
      "  default_lease:",
      "    max_tool_calls: 10",
      "    max_tokens: 10000",
      "  hard_ceiling:",
      "    max_tool_calls: 20",
      "    max_tokens: 20000",
      "execution_hints:",
      "  preferred_tools: [read]",
      "  fallback_tools: []",
      `consumes: [${(input.consumes ?? []).join(", ")}]`,
      `requires: [${(input.requires ?? []).join(", ")}]`,
      "---",
      `# ${input.name}`,
      "",
      "## Intent",
      "",
      "Test skill.",
    ].join("\n"),
    "utf8",
  );
}

function createRuntime(): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: workspace,
    config: createRuntimeConfig(),
  });
}

beforeEach(() => {
  workspace = createTestWorkspace("skill-validation-contract");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

describe("skill validation runtime contract", () => {
  test("preview and commit fail closed when no active skill is loaded", () => {
    const runtime = createRuntime();
    const sessionId = "skill-validation-no-active-1";
    const expected = {
      ok: false,
      missing: [],
      invalid: [
        {
          name: "skill",
          reason: "No active skill is loaded for this session.",
        },
      ],
    };

    expect(runtime.inspect.skills.validateOutputs(sessionId, { summary: "ready" })).toEqual(
      expected,
    );
    expect(runtime.authority.skills.complete(sessionId, { summary: "ready" })).toEqual(expected);
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
  });

  test("preview and commit share the validator set, but commit rebuilds fresh evidence context", () => {
    writeSkill(join(workspace, ".brewva/skills/core/planning-contract/SKILL.md"), {
      name: "planning-contract",
      outputs: [
        "design_spec",
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ],
      semanticBindings: {
        design_spec: "planning.design_spec.v2",
        execution_plan: "planning.execution_plan.v2",
        execution_mode_hint: "planning.execution_mode_hint.v2",
        risk_register: "planning.risk_register.v2",
        implementation_targets: "planning.implementation_targets.v2",
      },
    });
    writeSkill(join(workspace, ".brewva/skills/core/review-contract/SKILL.md"), {
      name: "review-contract",
      outputs: ["review_report", "merge_decision"],
      semanticBindings: {
        review_report: "review.review_report.v2",
        merge_decision: "review.merge_decision.v2",
      },
      consumes: [
        "design_spec",
        "execution_plan",
        "risk_register",
        "implementation_targets",
        "verification_evidence",
      ],
    });

    const runtime = createRuntime();
    const sessionId = "skill-validation-freshness-1";

    runtime.authority.skills.activate(sessionId, "planning-contract");
    const planningCompletion = runtime.authority.skills.complete(sessionId, {
      design_spec:
        "Validation must preserve preview semantics while rebuilding evidence freshness at commit time.",
      execution_plan: [
        {
          step: "Extract semantic validation into a dedicated runtime-owned pipeline.",
          intent:
            "Keep completion semantics stable while moving validation out of lifecycle ownership.",
          owner: "runtime.skills",
          exit_criteria: "Preview and commit both call the same closed validator composition.",
          verification_intent:
            "A contract regression confirms stale evidence is re-evaluated at commit.",
        },
        {
          step: "Make commit-time validation rebuild evidence after verification completes.",
          intent:
            "Prevent preview decisions from leaking stale evidence into authoritative completion.",
          owner: "runtime.commit",
          exit_criteria: "Commit rejects review output after verification freshness becomes stale.",
          verification_intent:
            "A runtime contract test toggles freshness between preview and commit.",
        },
      ],
      execution_mode_hint: "direct_patch",
      risk_register: [
        {
          risk: "Commit could reuse stale preview evidence and incorrectly accept review output.",
          category: "public_api",
          severity: "high",
          mitigation: "Rebuild validation context after verification before committing outputs.",
          required_evidence: ["runtime_verification_freshness"],
          owner_lane: "review-operability",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
          kind: "module",
          owner_boundary: "runtime.authority.skills",
          reason: "The lifecycle completion boundary remains authoritative here.",
        },
      ],
    });
    expect(planningCompletion).toEqual({ ok: true, missing: [], invalid: [] });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 100,
      payload: {
        outcome: "pass",
        level: "standard",
        activeSkill: "implementation",
        evidenceFreshness: "fresh",
        commandsExecuted: ["runtime_verification_freshness"],
        failedChecks: [],
        checkResults: [
          {
            name: "runtime_verification_freshness",
            status: "pass",
            evidence: "runtime_verification_freshness passed",
          },
        ],
      },
    });

    runtime.authority.skills.activate(sessionId, "review-contract");
    const outputs = {
      review_report: {
        summary:
          "Review is ready while fresh verification evidence still matches the planning contract.",
        activated_lanes: ["review-operability"],
        activation_basis: [
          "Fresh runtime verification and current planning evidence were available.",
        ],
        missing_evidence: [],
        residual_blind_spots: [],
        precedent_query_summary:
          "Checked the runtime-owned validation boundary for stale-evidence handling.",
        precedent_consult_status: {
          status: "consulted",
        },
      },
      merge_decision: "ready",
    };

    const preview = runtime.inspect.skills.validateOutputs(sessionId, outputs);
    expect(preview).toEqual({ ok: true, missing: [], invalid: [] });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "verification_write_marked",
      timestamp: 200,
      payload: {
        toolName: "edit",
      },
    });

    const finalized = runtime.authority.skills.complete(sessionId, outputs);
    expect(finalized.ok).toBeFalse();
    if (finalized.ok) {
      throw new Error("Expected commit-time validation to reject stale evidence.");
    }
    expect(finalized.invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "review_report" }),
        expect.objectContaining({ name: "merge_decision" }),
      ]),
    );
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("review-contract");
  });

  test("semantic tier_a normalization issues reject non-planning skills at producer completion", () => {
    const cases: Array<{
      skillName: string;
      outputs: string[];
      semanticBindings: Record<string, string>;
      payload: Record<string, unknown>;
      expectedInvalid: string;
    }> = [
      {
        skillName: "implementation-tier-a",
        outputs: ["change_set", "files_changed"],
        semanticBindings: {
          change_set: "implementation.change_set.v2",
          files_changed: "implementation.files_changed.v2",
        },
        payload: {
          change_set: "Updated the implementation boundary.",
          files_changed: [],
        },
        expectedInvalid: "files_changed",
      },
      {
        skillName: "review-tier-a",
        outputs: ["review_report", "merge_decision"],
        semanticBindings: {
          review_report: "review.review_report.v2",
          merge_decision: "review.merge_decision.v2",
        },
        payload: {
          review_report: {
            summary: "Review completed with supporting rationale.",
            activated_lanes: ["review-correctness"],
            activation_basis: ["Reviewed the implementation change directly."],
            missing_evidence: [],
            residual_blind_spots: [],
            precedent_query_summary: "Reviewed precedent coverage for the change.",
            precedent_consult_status: {
              status: "not_required",
            },
          },
          merge_decision: "ship_it",
        },
        expectedInvalid: "merge_decision",
      },
      {
        skillName: "qa-tier-a",
        outputs: ["qa_report", "qa_verdict", "qa_checks"],
        semanticBindings: {
          qa_report: "qa.qa_report.v2",
          qa_verdict: "qa.qa_verdict.v2",
          qa_checks: "qa.qa_checks.v2",
        },
        payload: {
          qa_report: "QA covered the main execution path.",
          qa_verdict: "green",
          qa_checks: [],
        },
        expectedInvalid: "qa_verdict",
      },
      {
        skillName: "ship-tier-a",
        outputs: ["ship_report", "ship_decision"],
        semanticBindings: {
          ship_report: "ship.ship_report.v2",
          ship_decision: "ship.ship_decision.v2",
        },
        payload: {
          ship_report: "Ship posture reviewed.",
          ship_decision: "ship_it",
        },
        expectedInvalid: "ship_decision",
      },
    ];

    for (const testCase of cases) {
      writeSkill(join(workspace, `.brewva/skills/core/${testCase.skillName}/SKILL.md`), {
        name: testCase.skillName,
        outputs: testCase.outputs,
        semanticBindings: testCase.semanticBindings,
      });
    }

    const runtime = createRuntime();

    for (const [index, testCase] of cases.entries()) {
      const sessionId = `skill-validation-tier-a-${index + 1}`;
      runtime.authority.skills.activate(sessionId, testCase.skillName);
      const result = runtime.authority.skills.complete(sessionId, testCase.payload);
      expect(result.ok).toBeFalse();
      if (result.ok) {
        throw new Error(`Expected ${testCase.skillName} completion to fail.`);
      }
      expect(result.invalid).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: testCase.expectedInvalid,
          }),
        ]),
      );
      expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe(testCase.skillName);
    }
  });

  test("ship completion rejects ready posture when consumed review or QA gates remain open", () => {
    writeSkill(join(workspace, ".brewva/skills/core/review-upstream/SKILL.md"), {
      name: "review-upstream",
      outputs: ["review_report", "review_findings", "merge_decision"],
      semanticBindings: {
        review_report: "review.review_report.v2",
        review_findings: "review.review_findings.v2",
        merge_decision: "review.merge_decision.v2",
      },
    });
    writeSkill(join(workspace, ".brewva/skills/core/qa-upstream/SKILL.md"), {
      name: "qa-upstream",
      outputs: [
        "qa_report",
        "qa_verdict",
        "qa_checks",
        "qa_missing_evidence",
        "qa_confidence_gaps",
      ],
      semanticBindings: {
        qa_report: "qa.qa_report.v2",
        qa_verdict: "qa.qa_verdict.v2",
        qa_checks: "qa.qa_checks.v2",
        qa_missing_evidence: "qa.qa_missing_evidence.v2",
        qa_confidence_gaps: "qa.qa_confidence_gaps.v2",
      },
    });
    writeSkill(join(workspace, ".brewva/skills/core/ship-contract/SKILL.md"), {
      name: "ship-contract",
      outputs: ["ship_report", "release_checklist", "ship_decision"],
      semanticBindings: {
        ship_report: "ship.ship_report.v2",
        release_checklist: "ship.release_checklist.v2",
        ship_decision: "ship.ship_decision.v2",
      },
      consumes: [
        "review_report",
        "merge_decision",
        "qa_verdict",
        "qa_checks",
        "qa_missing_evidence",
        "qa_confidence_gaps",
      ],
    });

    const runtime = createRuntime();
    const sessionId = "ship-validation-upstream-gates-1";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review-upstream",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: buildCanonicalReviewReport("Review completed and merge posture is ready."),
          review_findings: [],
          merge_decision: "ready",
        },
      },
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "skill_completed",
      timestamp: 110,
      payload: {
        skillName: "qa-upstream",
        outputKeys: [
          "qa_report",
          "qa_verdict",
          "qa_checks",
          "qa_missing_evidence",
          "qa_confidence_gaps",
        ],
        outputs: {
          qa_report: "QA covered the primary path but release evidence remains incomplete.",
          qa_verdict: "inconclusive",
          qa_checks: [
            {
              name: "Release smoke gate",
              status: "inconclusive",
              summary: "Smoke validation could not confirm the latest CI state.",
              tool: "manual",
              observed_output: "Latest CI run was missing for the current branch.",
            },
          ],
          qa_missing_evidence: ["latest_ci_run"],
          qa_confidence_gaps: [
            "release gate verification is not current on the latest branch state",
          ],
        },
      },
    });

    runtime.authority.skills.activate(sessionId, "ship-contract");
    const result = runtime.authority.skills.complete(sessionId, {
      ship_report: "Release posture reviewed for PR handoff.",
      release_checklist: [
        {
          item: "Review gate",
          status: "ready",
          evidence: "Review reported ready on the latest branch state.",
        },
      ],
      ship_decision: "ready",
    });

    expect(result.ok).toBeFalse();
    if (result.ok) {
      throw new Error("Expected ship completion to reject unresolved QA gates.");
    }
    expect(result.invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ship_decision",
        }),
      ]),
    );
  });
});
