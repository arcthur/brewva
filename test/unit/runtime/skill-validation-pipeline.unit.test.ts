import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime";
import { RuntimeSessionStateStore } from "../../../packages/brewva-runtime/src/services/session-state.js";
import {
  getSkillOutputContracts,
  getSkillSemanticBindings,
} from "../../../packages/brewva-runtime/src/skills/facets.js";
import { SkillRegistry } from "../../../packages/brewva-runtime/src/skills/registry.js";
import { SkillValidationContextBuilder } from "../../../packages/brewva-runtime/src/skills/validation/builders/validation-context-builder.js";
import type { SkillValidationContext } from "../../../packages/brewva-runtime/src/skills/validation/context.js";
import { resolveSkillVerificationEvidenceContext } from "../../../packages/brewva-runtime/src/skills/validation/evidence.js";
import { SkillOutputValidationPipeline } from "../../../packages/brewva-runtime/src/skills/validation/pipeline.js";
import { ContractValidator } from "../../../packages/brewva-runtime/src/skills/validation/validators/contract-validator.js";
import { PlanningOutputValidator } from "../../../packages/brewva-runtime/src/skills/validation/validators/planning-validator.js";
import { ReviewOutputValidator } from "../../../packages/brewva-runtime/src/skills/validation/validators/review-validator.js";
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

function loadRegistry(workspaceRoot: string): SkillRegistry {
  const registry = new SkillRegistry({
    workspaceRoot,
    config: createRuntimeConfig(),
  });
  registry.load();
  return registry;
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
        design_spec: "planning.design_spec.v1",
        execution_plan: "planning.execution_plan.v1",
        execution_mode_hint: "planning.execution_mode_hint.v1",
        risk_register: "planning.risk_register.v1",
        implementation_targets: "planning.implementation_targets.v1",
      },
    });
    const registry = loadRegistry(workspace);
    const skill = registry.get("design-contract");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected design-contract skill to load.");
    }

    const semanticBindings = getSkillSemanticBindings(skill.contract);
    const context: SkillValidationContext = {
      sessionId: "pipeline-1",
      skill,
      outputs: {
        design_spec: "test",
        execution_plan: ["broken"],
        execution_mode_hint: "unsupported",
        risk_register: [],
        implementation_targets: [],
      },
      consumedOutputs: {},
      outputContracts: getSkillOutputContracts(skill.contract),
      semanticBindings,
      semanticSchemaIds: new Set(Object.values(semanticBindings ?? {})),
      evidence: {
        getPlanningEvidenceState: () => ({}),
        getVerificationEvidenceContext: () => ({ state: "missing", coverageTexts: [] }),
        getVerificationCoverageTexts: () => [],
      },
    };

    const pipeline = new SkillOutputValidationPipeline([
      new ContractValidator(),
      new PlanningOutputValidator(),
    ]);
    const result = pipeline.validate(context);
    expect(result.ok).toBeFalse();
    if (result.ok) {
      throw new Error("Expected planning validation to fail.");
    }

    expect(result.missing).toEqual(
      expect.arrayContaining(["risk_register", "implementation_targets"]),
    );
    expect(result.invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "design_spec",
          schemaId: "planning.design_spec.v1",
        }),
        expect.objectContaining({
          name: "execution_mode_hint",
          schemaId: "planning.execution_mode_hint.v1",
        }),
      ]),
    );
  });

  test("derives and enforces semantic contracts for pre-implementation outputs", () => {
    writeSkill(join(workspace, ".brewva/skills/core/pre-implementation-contract/SKILL.md"), {
      name: "pre-implementation-contract",
      outputs: [
        "implementation_targets",
        "success_criteria",
        "approach_simplicity_check",
        "scope_declaration",
      ],
      semanticBindings: {
        implementation_targets: "planning.implementation_targets.v1",
        success_criteria: "planning.success_criteria.v1",
        approach_simplicity_check: "planning.approach_simplicity_check.v1",
        scope_declaration: "planning.scope_declaration.v1",
      },
    });
    const registry = loadRegistry(workspace);
    const skill = registry.get("pre-implementation-contract");
    expect(skill).toBeDefined();
    if (!skill) {
      throw new Error("Expected pre-implementation-contract skill to load.");
    }

    const semanticBindings = getSkillSemanticBindings(skill.contract);
    const context: SkillValidationContext = {
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
      consumedOutputs: {},
      outputContracts: getSkillOutputContracts(skill.contract),
      semanticBindings,
      semanticSchemaIds: new Set(Object.values(semanticBindings ?? {})),
      evidence: {
        getPlanningEvidenceState: () => ({}),
        getVerificationEvidenceContext: () => ({ state: "missing", coverageTexts: [] }),
        getVerificationCoverageTexts: () => [],
      },
    };

    const result = new SkillOutputValidationPipeline([new ContractValidator()]).validate(context);
    expect(result.ok).toBeFalse();
    if (result.ok) {
      throw new Error("Expected pre-implementation contract validation to fail.");
    }

    expect(result.missing).toEqual(expect.arrayContaining(["success_criteria"]));
    expect(result.invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "scope_declaration",
          schemaId: "planning.scope_declaration.v1",
        }),
      ]),
    );
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

    expect(builder.getConsumedOutputs(sessionId, "downstream")).toEqual({
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

    const semanticBindings = getSkillSemanticBindings(skill.contract);
    const context: SkillValidationContext = {
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
      outputContracts: getSkillOutputContracts(skill.contract),
      semanticBindings,
      semanticSchemaIds: new Set(Object.values(semanticBindings ?? {})),
      evidence: {
        getPlanningEvidenceState: () => ({}),
        getVerificationEvidenceContext: () => ({ state: "missing", coverageTexts: [] }),
        getVerificationCoverageTexts: () => [],
      },
    };

    expect(new ReviewOutputValidator().appliesTo(context)).toBeFalse();
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
    const sessionId = "builder-evidence-1";
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
