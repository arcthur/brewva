import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    boundaries: ["runtime.skills"],
    high_risk_touchpoints: ["runtime output registry handoff"],
    change_categories: ["public_api"],
    changed_file_classes: ["public_api"],
  };
}

describe("skill output registry", () => {
  test("completed skill outputs are queryable by subsequent skills", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "output-reg-1";

    runtime.skills.activate(sessionId, "repository-analysis");
    const outputs = {
      repository_snapshot: "monorepo with runtime, tools, cli, gateway",
      impact_map: buildImpactMap("routing, registry, docs"),
      planning_posture: "moderate",
      unknowns: ["No blocking unknowns remain after the repository inventory pass."],
    };
    runtime.skills.complete(sessionId, outputs);

    const stored = requireDefined(
      runtime.skills.getOutputs(sessionId, "repository-analysis"),
      "Expected stored repository-analysis outputs.",
    );
    expect(stored.repository_snapshot).toContain("monorepo");
  });

  test("getConsumedOutputs returns matching outputs for downstream skills", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "output-reg-2";

    runtime.skills.activate(sessionId, "repository-analysis");
    runtime.skills.complete(sessionId, {
      repository_snapshot: "module map here",
      impact_map: buildImpactMap("routing and cascade"),
      planning_posture: "complex",
      unknowns: ["No blocking unknowns remain after validating the main code path."],
    });

    const debuggingAvailable = runtime.skills.getConsumedOutputs(sessionId, "debugging");
    expect(debuggingAvailable.repository_snapshot).toBe("module map here");
    expect(debuggingAvailable.impact_map).toMatchObject({
      summary: "routing and cascade",
      changed_file_classes: ["public_api"],
    });

    runtime.skills.activate(sessionId, "debugging");
    const completion = runtime.skills.complete(sessionId, {
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

    const implementationAvailable = runtime.skills.getConsumedOutputs(sessionId, "implementation");
    expect(implementationAvailable.root_cause).toBe("continuity gate was missing");
    expect(implementationAvailable.fix_strategy).toBe("add continuity-aware filtering");
  });

  test("getConsumedOutputs returns empty for unknown skill", async () => {
    const runtime = createCleanRuntime();
    const result = runtime.skills.getConsumedOutputs("any-session", "nonexistent");
    expect(result).toEqual({});
  });

  test("replays skill outputs from skill_completed events after runtime restart", async () => {
    const sessionId = `skill-output-replay-${Date.now()}`;
    const runtimeA = createCleanRuntime();
    runtimeA.skills.activate(sessionId, "repository-analysis");
    runtimeA.skills.complete(sessionId, {
      repository_snapshot: "replayed module map",
      impact_map: buildImpactMap("registry and router"),
      planning_posture: "moderate",
      unknowns: ["No unresolved repository gaps remained at replay capture time."],
    });

    const runtimeB = createCleanRuntime();
    runtimeB.context.onTurnStart(sessionId, 1);
    const replayed = runtimeB.skills.getConsumedOutputs(sessionId, "debugging");
    expect(replayed.repository_snapshot).toBe("replayed module map");
  });

  test("emits skill_completed event with outputs and output keys", async () => {
    const runtime = createCleanRuntime();
    const sessionId = `skill-complete-event-${Date.now()}`;
    runtime.skills.activate(sessionId, "repository-analysis");
    const outputs = {
      repository_snapshot: "repository layout for runtime, tools, and gateway modules",
      impact_map: buildImpactMap("routing flow and registry boundaries touched by the change"),
      planning_posture: "moderate",
      unknowns: ["No blocking repository blind spots remained after the analysis pass."],
    };
    runtime.skills.complete(sessionId, outputs);

    const event = requireDefined(
      runtime.events.query(sessionId, { type: "skill_completed", last: 1 })[0],
      "Expected skill_completed event.",
    );
    const payload = (event.payload ?? {}) as {
      skillName?: string;
      outputKeys?: string[];
      outputs?: Record<string, unknown>;
    };
    expect(payload.skillName).toBe("repository-analysis");
    expect(payload.outputKeys).toEqual([
      "impact_map",
      "planning_posture",
      "repository_snapshot",
      "unknowns",
    ]);
    expect(payload.outputs).toEqual(outputs);
  });

  test("emits skill_activated event when a skill is loaded", async () => {
    const runtime = createCleanRuntime();
    const sessionId = `skill-activated-event-${Date.now()}`;
    runtime.skills.activate(sessionId, "repository-analysis");

    const event = requireDefined(
      runtime.events.query(sessionId, { type: "skill_activated", last: 1 })[0],
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

    runtime.skills.activate(sessionId, "repository-analysis");
    const completion = runtime.skills.complete(sessionId, {
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

    const taskState = runtime.task.getState(sessionId);
    expect(taskState.spec?.goal).toBe("Stabilize verification outcome semantics");
    expect(taskState.spec?.constraints).toEqual(["Prefer deterministic events"]);
  });
});
