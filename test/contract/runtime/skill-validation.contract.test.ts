import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { createRuntimeConfig } from "../../helpers/runtime.js";
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
        design_spec: "planning.design_spec.v1",
        execution_plan: "planning.execution_plan.v1",
        execution_mode_hint: "planning.execution_mode_hint.v1",
        risk_register: "planning.risk_register.v1",
        implementation_targets: "planning.implementation_targets.v1",
      },
    });
    writeSkill(join(workspace, ".brewva/skills/core/review-contract/SKILL.md"), {
      name: "review-contract",
      outputs: ["review_report", "merge_decision"],
      semanticBindings: {
        review_report: "review.review_report.v1",
        merge_decision: "review.merge_decision.v1",
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
});
