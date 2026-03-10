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

function buildEvidenceRef(sessionId: string) {
  return {
    id: `${sessionId}:broker-trace`,
    sourceType: "broker_trace" as const,
    locator: "broker://test",
    createdAt: Date.now(),
  };
}

function submitSelection(runtime: BrewvaRuntime, sessionId: string, skillName: string) {
  runtime.context.onTurnStart(sessionId, 1);
  return runtime.proposals.submit(sessionId, {
    id: `${sessionId}:selection`,
    kind: "skill_selection",
    issuer: "test.broker",
    subject: `select:${skillName}`,
    payload: {
      selected: [
        {
          name: skillName,
          score: 30,
          reason: `semantic:${skillName}`,
          breakdown: [{ signal: "semantic_match", term: skillName, delta: 30 }],
        },
      ],
      routingOutcome: "selected",
    },
    evidenceRefs: [buildEvidenceRef(sessionId)],
    createdAt: Date.now(),
  });
}

function submitChain(runtime: BrewvaRuntime, sessionId: string, steps: string[]) {
  return runtime.proposals.submit(sessionId, {
    id: `${sessionId}:chain`,
    kind: "skill_chain_intent",
    issuer: "test.broker",
    subject: `chain:${steps.join("->")}`,
    payload: {
      steps: steps.map((skill) => ({ skill })),
      source: "test",
    },
    evidenceRefs: [buildEvidenceRef(sessionId)],
    createdAt: Date.now(),
  });
}

function buildSkillOutputs(runtime: BrewvaRuntime, skillName: string): Record<string, unknown> {
  const skill = runtime.skills.get(skillName);
  const outputs = skill?.contract.outputs ?? [];
  return Object.fromEntries(outputs.map((output) => [output, `${output}:ok`]));
}

describe("skill cascade orchestration", () => {
  test("accepted skill_selection proposals still arm the dispatch gate", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("selection-commitment"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-selection-1";

    const receipt = submitSelection(runtime, sessionId, "repository-analysis");
    expect(receipt.decision).toBe("accept");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("repository-analysis");
    expect(runtime.skills.getCascadeIntent(sessionId)?.source).toBe("dispatch");
  });

  test("accepted chain proposals create runtime cascade intent", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("chain-commitment"),
      config: createConfig("assist"),
    });
    const sessionId = "skill-cascade-chain-1";

    const receipt = submitChain(runtime, sessionId, ["repository-analysis", "review"]);
    expect(receipt.decision).toBe("accept");
    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("explicit");
    expect(intent?.steps.map((step) => step.skill)).toEqual(["repository-analysis", "review"]);
  });

  test("dispatch-disabled cascade source does not block explicit proposal chains", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("explicit-priority"),
      config: createConfig("auto", ["explicit", "dispatch"], ["explicit"]),
    });
    const sessionId = "skill-cascade-explicit-priority";

    const receipt = submitChain(runtime, sessionId, ["design"]);
    expect(receipt.decision).toBe("accept");
    expect(runtime.skills.getCascadeIntent(sessionId)?.steps.map((step) => step.skill)).toEqual([
      "design",
    ]);
  });

  test("explicit intents still advance after manual completion", () => {
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
