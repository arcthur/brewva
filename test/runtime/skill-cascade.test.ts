import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-skill-cascade-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function createConfig(
  mode: BrewvaConfig["skills"]["cascade"]["mode"],
  sourcePriority: BrewvaConfig["skills"]["cascade"]["sourcePriority"] = ["explicit", "dispatch"],
  enabledSources: BrewvaConfig["skills"]["cascade"]["enabledSources"] = sourcePriority,
): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.projection.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.skills.cascade.mode = mode;
  config.skills.cascade.enabledSources = enabledSources;
  config.skills.cascade.sourcePriority = sourcePriority;
  return config;
}

function buildSkillOutputs(runtime: BrewvaRuntime, skillName: string): Record<string, unknown> {
  const skill = runtime.skills.get(skillName);
  const outputs = skill?.contract.outputs ?? [];
  return Object.fromEntries(outputs.map((output) => [output, `${output}:ok`]));
}

function seedSelection(runtime: BrewvaRuntime, sessionId: string, skillName: string): void {
  runtime.context.onTurnStart(sessionId, 1);
  runtime.skills.setNextSelection(sessionId, [
    {
      name: skillName,
      score: 30,
      reason: `semantic:${skillName}`,
      breakdown: [{ signal: "semantic_match", term: skillName, delta: 30 }],
    },
  ]);
}

describe("skill cascade orchestration", () => {
  test("auto mode activates the routed skill immediately when no prerequisites are missing", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("auto"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-auto-1";

    seedSelection(runtime, sessionId, "repository-analysis");
    runtime.skills.prepareDispatch(sessionId, "Map the repository structure");

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("dispatch");
    expect(intent?.status).toBe("running");
    expect(intent?.steps.map((step) => step.skill)).toEqual(["repository-analysis"]);
    expect(runtime.skills.getActive(sessionId)?.name).toBe("repository-analysis");
  });

  test("assist mode plans a dispatch chain but waits for manual activation", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("assist"),
      config: createConfig("assist"),
    });
    const sessionId = "skill-cascade-assist-1";

    seedSelection(runtime, sessionId, "review");
    runtime.skills.prepareDispatch(sessionId, "Review this change for risk");

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("dispatch");
    expect(intent?.status).toBe("paused");
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
  });

  test("off mode keeps dispatch routing out of cascade", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("off"),
      config: createConfig("off"),
    });
    const sessionId = "skill-cascade-off-1";

    seedSelection(runtime, sessionId, "design");
    runtime.skills.prepareDispatch(sessionId, "Design the taxonomy refactor");

    expect(runtime.skills.getCascadeIntent(sessionId)).toBeUndefined();
    expect(runtime.events.query(sessionId, { type: "skill_cascade_planned" })).toHaveLength(0);
  });

  test("explicit intents remain authoritative over dispatch reroutes", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("explicit-priority"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-explicit-1";

    const explicit = runtime.skills.startCascade(sessionId, {
      steps: [{ skill: "design" }],
    });
    expect(explicit.ok).toBe(true);
    expect(runtime.skills.getCascadeIntent(sessionId)?.source).toBe("explicit");

    seedSelection(runtime, sessionId, "review");
    runtime.skills.prepareDispatch(sessionId, "Review the current plan");

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("explicit");
    expect(intent?.steps.map((step) => step.skill)).toEqual(["design"]);
  });

  test("dispatch source can be disabled explicitly", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("dispatch-disabled"),
      config: createConfig("auto", ["explicit", "dispatch"], ["explicit"]),
    });
    const sessionId = "skill-cascade-dispatch-disabled-1";

    seedSelection(runtime, sessionId, "review");
    runtime.skills.prepareDispatch(sessionId, "Review the current plan");

    expect(runtime.skills.getCascadeIntent(sessionId)).toBeUndefined();
    const latest = runtime.events.query(sessionId, {
      type: "skill_cascade_overridden",
      last: 1,
    })[0];
    expect(latest?.payload?.reason).toBe("source_decision_rejected");
  });

  test("explicit intent advances after manual completion", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("explicit-complete"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-explicit-complete-1";

    const started = runtime.skills.startCascade(sessionId, {
      steps: [{ skill: "repository-analysis" }, { skill: "review" }],
    });
    expect(started.ok).toBe(true);
    expect(runtime.skills.getActive(sessionId)?.name).toBe("repository-analysis");

    expect(
      runtime.skills.complete(sessionId, buildSkillOutputs(runtime, "repository-analysis")).ok,
    ).toBe(true);
    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.cursor).toBe(1);
    expect(runtime.skills.getActive(sessionId)?.name).toBe("review");
  });
});
