import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asBrewvaSessionId, type BrewvaEventRecord } from "@brewva/brewva-runtime";
import { RuntimeSessionStateStore } from "../../../packages/brewva-runtime/src/services/session-state.js";
import {
  getSkillOutputContracts,
  getSkillSemanticBindings,
} from "../../../packages/brewva-runtime/src/skills/facets.js";
import { normalizeSkillOutputs } from "../../../packages/brewva-runtime/src/skills/normalization.js";
import { SkillRegistry } from "../../../packages/brewva-runtime/src/skills/registry.js";
import { SkillValidationContextBuilder } from "../../../packages/brewva-runtime/src/skills/validation/builders/validation-context-builder.js";
import type { SkillValidationContext } from "../../../packages/brewva-runtime/src/skills/validation/context.js";
import { resolveSkillVerificationEvidenceContext } from "../../../packages/brewva-runtime/src/skills/validation/evidence.js";
import { SkillOutputValidationPipeline } from "../../../packages/brewva-runtime/src/skills/validation/pipeline.js";
import { ConsumedOutputBlockingValidator } from "../../../packages/brewva-runtime/src/skills/validation/validators/consumed-output-blocking-validator.js";
import { ContractValidator } from "../../../packages/brewva-runtime/src/skills/validation/validators/contract-validator.js";
import { PlanningOutputValidator } from "../../../packages/brewva-runtime/src/skills/validation/validators/planning-validator.js";
import { ReviewOutputValidator } from "../../../packages/brewva-runtime/src/skills/validation/validators/review-validator.js";
import { ShipOutputValidator } from "../../../packages/brewva-runtime/src/skills/validation/validators/ship-validator.js";
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

function loadRegistry(workspaceRoot: string): SkillRegistry {
  const registry = new SkillRegistry({
    workspaceRoot,
    config: createRuntimeConfig(),
  });
  registry.load();
  return registry;
}

function buildValidationContext(input: {
  sessionId: string;
  skill: NonNullable<ReturnType<SkillRegistry["get"]>>;
  outputs: Record<string, unknown>;
  consumedOutputs?: Record<string, unknown>;
  consumedOutputView?: SkillValidationContext["consumedOutputView"];
}): SkillValidationContext {
  const semanticBindings = getSkillSemanticBindings(input.skill.contract);
  const consumedOutputs = input.consumedOutputs ?? {};
  const consumedOutputView = input.consumedOutputView ?? {
    outputs: consumedOutputs,
    issues: [],
    blockingState: {
      status: "ready" as const,
      raw_present: Object.keys(consumedOutputs).length > 0,
      normalized_present: Object.keys(consumedOutputs).length > 0,
      partial: false,
      unresolved: [],
    },
    normalizerVersion: "test",
    sourceSkillNames: [],
    sourceEventIds: [],
  };
  return {
    sessionId: input.sessionId,
    skill: input.skill,
    outputs: input.outputs,
    consumedOutputs,
    consumedOutputView,
    normalizedOutputs: normalizeSkillOutputs({
      outputs: input.outputs,
      semanticBindings,
    }),
    outputContracts: getSkillOutputContracts(input.skill.contract),
    semanticBindings,
    semanticSchemaIds: new Set(Object.values(semanticBindings ?? {})),
    evidence: {
      getPlanningEvidenceState: () => ({}),
      getVerificationEvidenceContext: () => ({ state: "missing", coverageTexts: [] }),
      getVerificationCoverageTexts: () => [],
    },
  };
}

beforeEach(() => {
  workspace = createTestWorkspace("skill-validation-pipeline-unit");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

describe("skill validation pipeline", () => {
  test("combines contract and semantic planning validation in one closed pass", () => {
    writeSkill(join(workspace, ".brewva/skills/core/design-contract/SKILL.md"), {
      name: "design-contract",
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
    const registry = loadRegistry(workspace);
    const skill = registry.get("design-contract");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected design-contract skill to load.");
    }

    const context = buildValidationContext({
      sessionId: "pipeline-1",
      skill,
      outputs: {
        design_spec: "test",
        execution_plan: ["broken"],
        execution_mode_hint: "unsupported",
        risk_register: [],
        implementation_targets: [],
      },
    });

    const pipeline = new SkillOutputValidationPipeline([
      new ContractValidator(),
      new PlanningOutputValidator(),
    ]);
    const result = pipeline.validate(context);
    expect(result).toEqual({ ok: true, missing: [], invalid: [] });
    expect(context.normalizedOutputs.blockingState.status).toBe("partial");
    expect(context.normalizedOutputs.blockingState.unresolved).toEqual(
      expect.arrayContaining(["execution_plan", "implementation_targets"]),
    );
  });

  test("keeps tier_c-only semantic drift ready while surfacing partial metadata", () => {
    writeSkill(join(workspace, ".brewva/skills/core/design-advisory/SKILL.md"), {
      name: "design-advisory",
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
    const registry = loadRegistry(workspace);
    const skill = registry.get("design-advisory");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected design-advisory skill to load.");
    }

    const context = buildValidationContext({
      sessionId: "pipeline-advisory-1",
      skill,
      outputs: {
        design_spec: "Keep advisory taxonomy drift visible without blocking workflow progression.",
        execution_plan: [
          {
            step: "Normalize planning outputs.",
            intent: "Preserve canonical structure while tolerating advisory enum drift.",
            owner: "runtime.authority.skills",
            exit_criteria: "Tier C issues remain inspectable metadata.",
            verification_intent: "Workflow state stays ready when only advisory drift exists.",
          },
        ],
        execution_mode_hint: "direct_patch",
        risk_register: [
          {
            risk: "Advisory taxonomy drift could masquerade as a blocker.",
            category: "cross_session",
            severity: "medium",
            mitigation: "Preserve drift as issues while leaving blockingState ready.",
            required_evidence: ["tier_c_status_guard"],
            owner_lane: "review-ghost",
          },
        ],
        implementation_targets: [
          {
            target: "packages/brewva-runtime/src/contracts/planning.ts",
            kind: "module",
            owner_boundary: "runtime.contracts",
            reason: "Planning normalization lives here.",
          },
        ],
      },
    });

    const result = new SkillOutputValidationPipeline([
      new ContractValidator(),
      new PlanningOutputValidator(),
    ]).validate(context);
    expect(result).toEqual({ ok: true, missing: [], invalid: [] });
    expect(context.normalizedOutputs.blockingState).toEqual(
      expect.objectContaining({
        status: "ready",
        partial: true,
      }),
    );
    expect(context.normalizedOutputs.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "risk_register[0].owner_lane", tier: "tier_c" }),
      ]),
    );
  });

  test("rejects tier_a normalization issues for non-planning semantic outputs", () => {
    writeSkill(join(workspace, ".brewva/skills/core/implementation-contract/SKILL.md"), {
      name: "implementation-contract",
      outputs: ["change_set", "files_changed"],
      semanticBindings: {
        change_set: "implementation.change_set.v2",
        files_changed: "implementation.files_changed.v2",
      },
    });
    const registry = loadRegistry(workspace);
    const skill = registry.get("implementation-contract");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected implementation-contract skill to load.");
    }

    const context = buildValidationContext({
      sessionId: "pipeline-implementation-tier-a-1",
      skill,
      outputs: {
        change_set: "Updated the lifecycle boundary.",
        files_changed: [],
      },
    });

    const result = new SkillOutputValidationPipeline([
      new ContractValidator(),
      new PlanningOutputValidator(),
    ]).validate(context);
    expect(result.ok).toBeFalse();
    if (result.ok) {
      throw new Error("Expected tier_a normalization drift to reject completion.");
    }
    expect(result.invalid).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "files_changed" })]),
    );
  });

  test("rejects consumed tier_b issues when the active skill is the named blocking consumer", () => {
    writeSkill(join(workspace, ".brewva/skills/core/implementation-consumer/SKILL.md"), {
      name: "implementation-consumer",
      outputs: ["change_set", "files_changed"],
      semanticBindings: {
        change_set: "implementation.change_set.v2",
        files_changed: "implementation.files_changed.v2",
      },
      consumes: ["implementation_targets"],
    });
    const registry = loadRegistry(workspace);
    const skill = registry.get("implementation-consumer");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected implementation-consumer skill to load.");
    }

    const context = buildValidationContext({
      sessionId: "pipeline-consumed-tier-b-1",
      skill,
      outputs: {
        change_set: "Applied the lifecycle fix to the runtime-owned boundary.",
        files_changed: ["packages/brewva-runtime/src/services/skill-lifecycle.ts"],
      },
      consumedOutputView: {
        outputs: {},
        issues: [
          {
            outputName: "implementation_targets",
            path: "implementation_targets",
            reason:
              "implementation_targets was present but no usable targets were normalized; implementation will block on scope ownership.",
            tier: "tier_b",
            blockingConsumer: "implementation-consumer",
            schemaId: "planning.implementation_targets.v2",
          },
        ],
        blockingState: {
          status: "partial",
          raw_present: true,
          normalized_present: false,
          partial: true,
          unresolved: ["implementation_targets"],
          blocking_consumer: "implementation-consumer",
        },
        normalizerVersion: "test",
        sourceSkillNames: ["design"],
        sourceEventIds: ["evt-design-consumed-tier-b"],
      },
    });

    const result = new SkillOutputValidationPipeline([
      new ContractValidator(),
      new PlanningOutputValidator(),
      new ConsumedOutputBlockingValidator(),
    ]).validate(context);
    expect(result.ok).toBeFalse();
    if (result.ok) {
      throw new Error("Expected named consumer tier_b issues to reject the downstream skill.");
    }
    expect(result.invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "implementation_targets",
          schemaId: "planning.implementation_targets.v2",
        }),
      ]),
    );
  });

  test("contract validation ignores semantic bindings without authored contracts", () => {
    writeSkill(join(workspace, ".brewva/skills/core/pre-implementation-contract/SKILL.md"), {
      name: "pre-implementation-contract",
      outputs: [
        "implementation_targets",
        "success_criteria",
        "approach_simplicity_check",
        "scope_declaration",
      ],
      semanticBindings: {
        implementation_targets: "planning.implementation_targets.v2",
        success_criteria: "planning.success_criteria.v2",
        approach_simplicity_check: "planning.approach_simplicity_check.v2",
        scope_declaration: "planning.scope_declaration.v2",
      },
    });
    const registry = loadRegistry(workspace);
    const skill = registry.get("pre-implementation-contract");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected pre-implementation-contract skill to load.");
    }

    const context = buildValidationContext({
      sessionId: "pipeline-pre-implementation-1",
      skill,
      outputs: {
        implementation_targets: [
          {
            target: "packages/brewva-gateway/src/handlers/signup.ts",
            kind: "source",
            owner_boundary: "gateway-signup-handler",
            reason: "Add email format guard before credential creation.",
          },
        ],
        success_criteria: [],
        approach_simplicity_check: {
          verdict: "acceptable",
          speculative_features: [],
          over_abstracted: false,
          flags: [],
        },
        scope_declaration: {
          will_change: ["signup handler"],
          will_not_change: [],
        },
      },
    });

    expect(context.outputContracts).toEqual({});

    const result = new SkillOutputValidationPipeline([new ContractValidator()]).validate(context);
    expect(result).toEqual({ ok: true, missing: [], invalid: [] });
  });

  test("builder derives consumed outputs from prior completed skills", () => {
    writeSkill(join(workspace, ".brewva/skills/core/producer/SKILL.md"), {
      name: "producer",
      outputs: ["repository_snapshot", "impact_map"],
    });
    writeSkill(join(workspace, ".brewva/skills/core/downstream/SKILL.md"), {
      name: "downstream",
      outputs: ["summary"],
      consumes: ["repository_snapshot", "impact_map"],
    });
    const registry = loadRegistry(workspace);
    const sessionState = new RuntimeSessionStateStore();
    const sessionId = "builder-consumed-1";

    sessionState.getCell(sessionId).skillOutputs.set("producer", {
      skillName: "producer",
      completedAt: Date.now(),
      outputs: {
        repository_snapshot: "runtime, tools, and gateway are present",
        impact_map: {
          summary: "validation cutover",
        },
      },
    });

    const builder = new SkillValidationContextBuilder({
      skills: registry,
      sessionState,
      listEvents: () => [],
    });

    expect(builder.getConsumedOutputs(sessionId, "downstream").outputs).toEqual({
      repository_snapshot: "runtime, tools, and gateway are present",
      impact_map: {
        summary: "validation cutover",
      },
    });
  });

  test("review validator does not treat execution_mode_hint-only inputs as review evidence", () => {
    writeSkill(join(workspace, ".brewva/skills/core/review-adjacent/SKILL.md"), {
      name: "review-adjacent",
      outputs: ["review_report", "review_findings", "merge_decision"],
      consumes: ["execution_mode_hint"],
    });
    const registry = loadRegistry(workspace);
    const skill = registry.get("review-adjacent");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected review-adjacent skill to load.");
    }

    const context = buildValidationContext({
      sessionId: "review-adjacent-1",
      skill,
      outputs: {
        review_report: "A placeholder review artifact",
        review_findings: "A placeholder finding artifact",
        merge_decision: "ready",
      },
      consumedOutputs: {
        execution_mode_hint: "direct_patch",
      },
    });

    expect(new ReviewOutputValidator().appliesTo(context)).toBeFalse();
  });

  test("ship validator rejects ready decisions when review or QA release gates remain open", () => {
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
        "qa_missing_evidence",
        "qa_confidence_gaps",
        "qa_environment_limits",
      ],
    });
    const registry = loadRegistry(workspace);
    const skill = registry.get("ship-contract");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected ship-contract skill to load.");
    }

    const context = buildValidationContext({
      sessionId: "ship-contract-1",
      skill,
      outputs: {
        ship_report: "Release posture reviewed for the current branch.",
        release_checklist: [
          {
            item: "Review gate",
            status: "ready",
            evidence: "Review reported ready on the latest branch state.",
          },
        ],
        ship_decision: "ready",
      },
      consumedOutputs: {
        review_report: buildCanonicalReviewReport("Review gate is clear."),
        merge_decision: "ready",
        qa_verdict: "inconclusive",
        qa_missing_evidence: ["latest_ci_run"],
      },
    });

    expect(new ShipOutputValidator().validate(context).invalid).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "ship_decision" })]),
    );
  });

  test("builder rejects assembly without an event source", () => {
    writeSkill(join(workspace, ".brewva/skills/core/downstream/SKILL.md"), {
      name: "downstream",
      outputs: ["summary"],
    });
    const registry = loadRegistry(workspace);
    const sessionState = new RuntimeSessionStateStore();

    expect(() =>
      Reflect.construct(SkillValidationContextBuilder, [
        {
          skills: registry,
          sessionState,
        },
      ]),
    ).toThrow("Skill validation context builder requires listEvents().");
  });

  test("verification evidence helper requires runtime verification receipts", () => {
    expect(resolveSkillVerificationEvidenceContext([])).toEqual({
      state: "missing",
      coverageTexts: [],
    });
  });

  test("builder rebuilds verification freshness from the latest event tape snapshot", () => {
    writeSkill(join(workspace, ".brewva/skills/core/downstream/SKILL.md"), {
      name: "downstream",
      outputs: ["summary"],
    });
    const registry = loadRegistry(workspace);
    const sessionState = new RuntimeSessionStateStore();
    const sessionId = asBrewvaSessionId("builder-evidence-1");
    sessionState.getCell(sessionId).activeSkill = "downstream";

    let events: BrewvaEventRecord[] = [
      {
        id: "evt-1",
        sessionId,
        turn: 1,
        type: "verification_outcome_recorded",
        timestamp: 100,
        payload: {
          outcome: "pass",
          level: "standard",
          activeSkill: "implementation",
          evidenceFreshness: "fresh",
          commandsExecuted: ["plan_contract_tests"],
          failedChecks: [],
          checkResults: [
            {
              name: "plan_contract_tests",
              status: "pass",
              evidence: "plan_contract_tests passed",
            },
          ],
        },
      },
    ];

    const builder = new SkillValidationContextBuilder({
      skills: registry,
      sessionState,
      listEvents: () => events,
    });

    const previewContext = builder.build(sessionId, { summary: "ready" });
    expect(previewContext).toBeDefined();
    if (!previewContext) {
      throw new Error("Expected builder to produce validation context.");
    }
    expect(previewContext.evidence.getVerificationEvidenceContext()).toEqual({
      state: "present",
      coverageTexts: ["plan_contract_tests", "plan_contract_tests passed"],
    });

    events = [
      ...events,
      {
        id: "evt-2",
        sessionId,
        turn: 1,
        type: "verification_write_marked",
        timestamp: 200,
        payload: {
          toolName: "edit",
        },
      },
    ];

    const commitContext = builder.build(sessionId, { summary: "ready" });
    expect(commitContext).toBeDefined();
    if (!commitContext) {
      throw new Error("Expected builder to rebuild validation context.");
    }

    expect(previewContext.evidence.getVerificationEvidenceContext().state).toBe("present");
    expect(commitContext.evidence.getVerificationEvidenceContext().state).toBe("stale");
  });
});
