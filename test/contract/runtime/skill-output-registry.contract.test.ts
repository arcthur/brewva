import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("skill-output-registry-contract");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

function createCleanRuntime(): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: workspace,
    config: createRuntimeConfig(),
  });
}

function buildImpactMap(summary: string) {
  return {
    summary,
    affected_paths: ["packages/brewva-runtime/src/runtime.ts"],
    boundaries: ["runtime.authority.skills"],
    high_risk_touchpoints: ["runtime output registry handoff"],
    change_categories: ["public_api"],
    changed_file_classes: ["public_api"],
  };
}

type SkillFixtureInput = {
  name: string;
  outputs: string[];
  semanticBindings?: Record<string, string>;
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
      "  when_to_use: Use when the task needs the local registry skill.",
      "  examples: [test skill]",
      "  phases: [align]",
      "intent:",
      `  outputs: [${input.outputs.join(", ")}]`,
      ...(input.semanticBindings && Object.keys(input.semanticBindings).length > 0
        ? [
            "  semantic_bindings:",
            ...Object.entries(input.semanticBindings).map(
              ([outputName, schemaId]) => `    ${outputName}: ${schemaId}`,
            ),
          ]
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
      "consumes: []",
      "requires: []",
      "---",
      `# ${input.name}`,
      "",
      "Test skill.",
    ].join("\n"),
    "utf8",
  );
}

describe("skill output registry", () => {
  test("completed skill outputs are queryable by subsequent skills", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "output-reg-1";

    runtime.authority.skills.activate(sessionId, "repository-analysis");
    const outputs = {
      repository_snapshot: "monorepo with runtime, tools, cli, gateway",
      impact_map: buildImpactMap("routing, registry, docs"),
      planning_posture: "moderate",
      unknowns: ["No blocking unknowns remain after the repository inventory pass."],
    };
    runtime.authority.skills.complete(sessionId, outputs);

    const stored = requireDefined(
      runtime.inspect.skills.getRawOutputs(sessionId, "repository-analysis"),
      "Expected stored repository-analysis outputs.",
    );
    expect(stored.repository_snapshot).toContain("monorepo");
  });

  test("getConsumedOutputs returns matching outputs for downstream skills", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "output-reg-2";

    runtime.authority.skills.activate(sessionId, "repository-analysis");
    runtime.authority.skills.complete(sessionId, {
      repository_snapshot: "module map here",
      impact_map: buildImpactMap("routing and cascade"),
      planning_posture: "complex",
      unknowns: ["No blocking unknowns remain after validating the main code path."],
    });

    const debuggingAvailable = runtime.inspect.skills.getConsumedOutputs(sessionId, "debugging");
    expect(debuggingAvailable.outputs.repository_snapshot).toBe("module map here");
    expect(debuggingAvailable.outputs.impact_map).toMatchObject({
      summary: "routing and cascade",
      changed_file_classes: ["public_api"],
    });

    runtime.authority.skills.activate(sessionId, "debugging");
    const completion = runtime.authority.skills.complete(sessionId, {
      root_cause: "continuity gate was missing",
      fix_strategy: "add continuity-aware filtering",
      failure_evidence: "repro + failing route selection",
      investigation_record: {
        hypotheses_tried: [
          "routing regression in delegation resolution",
          "continuity gate omission in the repair path",
        ],
        failed_attempts: ["Patched route selection first; symptom persisted."],
        disconfirming_evidence: [
          "Route selection matched the expected owner after trace inspection.",
        ],
        final_root_cause: "continuity gate was missing",
        verification_linkage: "repro + failing route selection",
      },
      planning_posture: "complex",
    });
    expect(completion).toEqual({ ok: true, missing: [], invalid: [] });

    const implementationAvailable = runtime.inspect.skills.getConsumedOutputs(
      sessionId,
      "implementation",
    );
    expect(implementationAvailable.outputs.root_cause).toBe("continuity gate was missing");
    expect(implementationAvailable.outputs.fix_strategy).toBe("add continuity-aware filtering");
  });

  test("getConsumedOutputs returns empty for unknown skill", async () => {
    const runtime = createCleanRuntime();
    const result = runtime.inspect.skills.getConsumedOutputs("any-session", "nonexistent");
    expect(result.outputs).toEqual({});
    expect(result.issues).toEqual([]);
  });

  test("replays skill outputs from skill_completed events after runtime restart", async () => {
    const sessionId = `skill-output-replay-${Date.now()}`;
    const runtimeA = createCleanRuntime();
    runtimeA.authority.skills.activate(sessionId, "repository-analysis");
    runtimeA.authority.skills.complete(sessionId, {
      repository_snapshot: "replayed module map",
      impact_map: buildImpactMap("registry and router"),
      planning_posture: "moderate",
      unknowns: ["No unresolved repository gaps remained at replay capture time."],
    });

    const runtimeB = createCleanRuntime();
    runtimeB.maintain.context.onTurnStart(sessionId, 1);
    const replayed = runtimeB.inspect.skills.getConsumedOutputs(sessionId, "debugging");
    expect(replayed.outputs.repository_snapshot).toBe("replayed module map");
  });

  test("replays normalized outputs using the recorded semantic bindings even after local skill drift", async () => {
    const skillPath = join(workspace, ".brewva/skills/core/design-recorded/SKILL.md");
    const consumerSkillPath = join(workspace, ".brewva/skills/core/planning-consumer/SKILL.md");
    writeSkill(skillPath, {
      name: "design-recorded",
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
    mkdirSync(dirname(consumerSkillPath), { recursive: true });
    writeFileSync(
      consumerSkillPath,
      [
        "---",
        "name: planning-consumer",
        "description: planning-consumer skill",
        "selection:",
        "  when_to_use: Use when the task needs a downstream planning consumer.",
        "  examples: [planning consumer]",
        "  phases: [align]",
        "intent:",
        "  outputs: [summary]",
        "  output_contracts:",
        "    summary:",
        "      kind: text",
        "      min_length: 1",
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
        "consumes: [execution_mode_hint]",
        "requires: []",
        "---",
        "# planning-consumer",
        "",
        "Test skill.",
      ].join("\n"),
      "utf8",
    );

    const sessionId = `skill-output-recorded-bindings-${Date.now()}`;
    const runtimeA = createCleanRuntime();
    runtimeA.authority.skills.activate(sessionId, "design-recorded");
    runtimeA.authority.skills.complete(sessionId, {
      design_spec: "Preserve producer bindings on the durable event so replay stays stable.",
      execution_plan: [
        {
          step: "Persist semantic bindings alongside raw outputs.",
          intent: "Keep normalized replay independent of future skill document drift.",
          owner: "runtime.authority.skills",
          exit_criteria: "Replayed normalized outputs still expose canonical planning artifacts.",
          verification_intent:
            "A replay contract test rewrites the local skill and keeps normalization stable.",
        },
      ],
      execution_mode_hint: "Direct Patch",
      risk_register: [
        {
          risk: "Replay could reinterpret old outputs using a newer skill contract.",
          category: "public_api",
          severity: "high",
          mitigation: "Persist semantic bindings with the completion event and hydrated record.",
          required_evidence: ["recorded_semantic_bindings"],
          owner_lane: "review-correctness",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
          kind: "module",
          owner_boundary: "runtime.authority.skills",
          reason: "The completion event is emitted here.",
        },
      ],
    });

    writeSkill(skillPath, {
      name: "design-recorded",
      outputs: [
        "design_spec",
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ],
    });

    const runtimeB = createCleanRuntime();
    runtimeB.maintain.context.onTurnStart(sessionId, 1);
    const normalized = requireDefined(
      runtimeB.inspect.skills.getNormalizedOutputs(sessionId, "design-recorded"),
      "Expected replayed normalized outputs.",
    );
    expect(normalized.canonical.execution_plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "Persist semantic bindings alongside raw outputs.",
        }),
      ]),
    );
    expect(normalized.canonical.execution_mode_hint).toBe("direct_patch");
    expect(normalized.canonicalSchemaIds).toEqual(
      expect.arrayContaining([
        "planning.design_spec.v2",
        "planning.execution_plan.v2",
        "planning.execution_mode_hint.v2",
        "planning.risk_register.v2",
        "planning.implementation_targets.v2",
      ]),
    );
    const consumed = runtimeB.inspect.skills.getConsumedOutputs(sessionId, "planning-consumer");
    expect(consumed.outputs.execution_mode_hint).toBe("direct_patch");
  });

  test("emits skill_completed event with outputs and output keys", async () => {
    writeSkill(join(workspace, ".brewva/skills/core/semantic-event/SKILL.md"), {
      name: "semantic-event",
      outputs: ["design_spec"],
      semanticBindings: {
        design_spec: "planning.design_spec.v2",
      },
    });
    const runtime = createCleanRuntime();
    const sessionId = `skill-complete-event-${Date.now()}`;
    runtime.authority.skills.activate(sessionId, "semantic-event");
    const outputs = {
      design_spec:
        "Emit semantic bindings on the completion event so replay stays self-describing.",
    };
    runtime.authority.skills.complete(sessionId, outputs);

    const event = requireDefined(
      runtime.inspect.events.query(sessionId, { type: "skill_completed", last: 1 })[0],
      "Expected skill_completed event.",
    );
    const payload = (event.payload ?? {}) as {
      skillName?: string;
      outputKeys?: string[];
      outputs?: Record<string, unknown>;
      semanticBindings?: Record<string, string>;
    };
    expect(payload.skillName).toBe("semantic-event");
    expect(payload.outputKeys).toEqual(["design_spec"]);
    expect(payload.outputs).toEqual(outputs);
    expect(payload.semanticBindings).toEqual({
      design_spec: "planning.design_spec.v2",
    });
  });

  test("emits skill_activated event when a skill is loaded", async () => {
    const runtime = createCleanRuntime();
    const sessionId = `skill-activated-event-${Date.now()}`;
    runtime.authority.skills.activate(sessionId, "repository-analysis");

    const event = requireDefined(
      runtime.inspect.events.query(sessionId, { type: "skill_activated", last: 1 })[0],
      "Expected skill_activated event.",
    );
    const payload = (event.payload ?? {}) as {
      skillName?: string;
    };
    expect(payload.skillName).toBe("repository-analysis");
  });

  test("promotes task spec from task_spec output", async () => {
    const runtime = createCleanRuntime();
    const sessionId = `task-spec-output-${Date.now()}`;

    runtime.authority.skills.activate(sessionId, "repository-analysis");
    const completion = runtime.authority.skills.complete(sessionId, {
      repository_snapshot: "runtime, tools, projection",
      impact_map: buildImpactMap("verification, skill lifecycle"),
      planning_posture: "moderate",
      unknowns: ["No blocking unknowns remain after mapping runtime and projection ownership."],
      task_spec: {
        schema: "brewva.task.v1",
        goal: "Stabilize verification outcome semantics",
        constraints: ["Prefer deterministic events"],
      },
    });
    expect(completion).toEqual({ ok: true, missing: [], invalid: [] });

    const taskState = runtime.inspect.task.getState(sessionId);
    expect(taskState.spec?.goal).toBe("Stabilize verification outcome semantics");
    expect(taskState.spec?.constraints).toEqual(["Prefer deterministic events"]);
  });
});
