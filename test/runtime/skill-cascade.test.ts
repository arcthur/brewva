import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  type BrewvaConfig,
  type SkillCascadeChainSource,
} from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-skill-cascade-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function createConfig(
  mode: BrewvaConfig["skills"]["cascade"]["mode"],
  sourcePriority: BrewvaConfig["skills"]["cascade"]["sourcePriority"] = ["compose", "dispatch"],
  enabledSources: BrewvaConfig["skills"]["cascade"]["enabledSources"] = sourcePriority,
): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.memory.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.skills.cascade.mode = mode;
  config.skills.cascade.enabledSources = enabledSources;
  config.skills.cascade.sourcePriority = sourcePriority;
  return config;
}

function buildSkillOutputs(runtime: BrewvaRuntime, skillName: string): Record<string, unknown> {
  const skill = runtime.skills.get(skillName);
  const outputs = skill?.contract.outputs ?? [];
  const payload: Record<string, unknown> = {};
  for (const output of outputs) {
    payload[output] = `${output}:ok`;
  }
  if (payload["skill_sequence"] !== undefined) {
    payload["skill_sequence"] = [
      {
        id: "T1",
        skill: "exploration",
        consumes: [],
        produces: ["architecture_map", "key_modules", "unknowns"],
      },
    ];
  }
  return payload;
}

function seedPlanningDispatch(runtime: BrewvaRuntime, sessionId: string): void {
  runtime.context.onTurnStart(sessionId, 1);
  runtime.skills.setNextSelection(sessionId, [
    {
      name: "planning",
      score: 20,
      reason: "semantic:planning request",
      breakdown: [{ signal: "semantic_match", term: "planning", delta: 20 }],
    },
  ]);
}

function findLatestEvent(
  runtime: BrewvaRuntime,
  sessionId: string,
  type: string,
): { payload?: Record<string, unknown> } | undefined {
  const events = runtime.events.list(sessionId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== type) continue;
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : undefined;
    return { payload };
  }
  return undefined;
}

describe("skill cascade orchestration", () => {
  test("auto mode activates next step after skill completion", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("auto-advance"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-auto-1";

    seedPlanningDispatch(runtime, sessionId);
    runtime.skills.prepareDispatch(sessionId, "Plan and execute the refactor end-to-end");

    const initialIntent = runtime.skills.getCascadeIntent(sessionId);
    expect(initialIntent).toBeDefined();
    expect(initialIntent?.steps.length ?? 0).toBeGreaterThan(0);

    const firstStep = initialIntent?.steps[0]?.skill ?? "";
    expect(runtime.skills.getActive(sessionId)?.name).toBe(firstStep);
    const firstOutputs = buildSkillOutputs(runtime, firstStep);
    const completion = runtime.skills.complete(sessionId, firstOutputs);
    expect(completion.ok).toBe(true);

    const updatedIntent = runtime.skills.getCascadeIntent(sessionId);
    expect(updatedIntent).toBeDefined();
    expect((updatedIntent?.cursor ?? 0) >= 1).toBe(true);
    if (updatedIntent?.status === "running") {
      expect(runtime.skills.getActive(sessionId)?.name).toBe(
        updatedIntent.steps[updatedIntent.cursor]?.skill,
      );
    }
    if (updatedIntent?.status === "completed") {
      expect(updatedIntent?.status).toBe("completed");
    }
  });

  test("assist mode plans chain but waits for manual continuation", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("assist"),
      config: createConfig("assist"),
    });
    const sessionId = "skill-cascade-assist-1";

    seedPlanningDispatch(runtime, sessionId);
    runtime.skills.prepareDispatch(sessionId, "Plan and execute the refactor end-to-end");

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent).toBeDefined();
    expect(intent?.status).toBe("paused");
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();

    const firstSkill = intent?.steps[0]?.skill ?? "";
    expect(runtime.skills.activate(sessionId, firstSkill).ok).toBe(true);
    const completion = runtime.skills.complete(sessionId, buildSkillOutputs(runtime, firstSkill));
    expect(completion.ok).toBe(true);

    const after = runtime.skills.getCascadeIntent(sessionId);
    if ((after?.steps.length ?? 0) > 1) {
      const status = after?.status;
      expect(status).toBeDefined();
      if (status) {
        expect(["paused", "failed", "completed"]).toContain(status);
      }
      expect(runtime.skills.getActive(sessionId)).toBeUndefined();
    }
  });

  test("off mode keeps dispatch routing in manual flow", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("off-dispatch"),
      config: createConfig("off"),
    });
    const sessionId = "skill-cascade-off-dispatch-1";

    seedPlanningDispatch(runtime, sessionId);
    runtime.skills.prepareDispatch(sessionId, "Plan and execute the refactor end-to-end");

    expect(runtime.skills.getCascadeIntent(sessionId)).toBeUndefined();
    const cascadeEvents = runtime.events.query(sessionId, { type: "skill_cascade_planned" });
    expect(cascadeEvents.length).toBe(0);
  });

  test("off mode does not promote compose skill_sequence into cascade intent", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("off-compose"),
      config: createConfig("off"),
    });
    const sessionId = "skill-cascade-off-compose-1";

    runtime.context.onTurnStart(sessionId, 1);
    const activated = runtime.skills.activate(sessionId, "compose");
    expect(activated.ok).toBe(true);
    const completion = runtime.skills.complete(sessionId, {
      compose_analysis: "request_summary: should stay manual",
      compose_plan: "manual compose execution",
      skill_sequence: [
        {
          id: "T1",
          skill: "exploration",
          consumes: [],
          expected_outputs: ["architecture_map", "key_modules", "unknowns"],
        },
      ],
    });
    expect(completion.ok).toBe(true);
    expect(runtime.skills.getCascadeIntent(sessionId)).toBeUndefined();
    const cascadeEvents = runtime.events.query(sessionId, { type: "skill_cascade_replanned" });
    expect(cascadeEvents.length).toBe(0);
  });

  test("disabled dispatch source blocks auto cascade planning and emits rejection event", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("dispatch-disabled"),
      config: createConfig("auto", ["compose", "dispatch"], ["compose"]),
    });
    const sessionId = "skill-cascade-dispatch-disabled-1";

    seedPlanningDispatch(runtime, sessionId);
    runtime.skills.prepareDispatch(sessionId, "Plan and execute the refactor end-to-end");

    expect(runtime.skills.getCascadeIntent(sessionId)).toBeUndefined();
    const latest = findLatestEvent(runtime, sessionId, "skill_cascade_overridden");
    expect(latest).toBeDefined();
    expect(latest?.payload?.reason).toBe("source_decision_rejected");
    const sourceDecision =
      latest?.payload?.sourceDecision &&
      typeof latest.payload.sourceDecision === "object" &&
      !Array.isArray(latest.payload.sourceDecision)
        ? (latest.payload.sourceDecision as Record<string, unknown>)
        : undefined;
    expect(sourceDecision?.reason).toBe("incoming_source_disabled");
  });

  test("disabled compose source blocks sequence promotion and emits rejection event", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("compose-disabled"),
      config: createConfig("auto", ["compose", "dispatch"], ["dispatch"]),
    });
    const sessionId = "skill-cascade-compose-disabled-1";

    runtime.context.onTurnStart(sessionId, 1);
    const activated = runtime.skills.activate(sessionId, "compose");
    expect(activated.ok).toBe(true);
    const completion = runtime.skills.complete(sessionId, {
      compose_analysis: "request_summary: compose source should be disabled",
      compose_plan: "compose plan should not be promoted",
      skill_sequence: [
        {
          id: "T1",
          skill: "exploration",
          consumes: [],
          expected_outputs: ["architecture_map", "key_modules", "unknowns"],
        },
      ],
    });
    expect(completion.ok).toBe(true);

    expect(runtime.skills.getCascadeIntent(sessionId)).toBeUndefined();
    const latest = findLatestEvent(runtime, sessionId, "skill_cascade_overridden");
    expect(latest).toBeDefined();
    expect(latest?.payload?.reason).toBe("source_decision_rejected");
    const sourceDecision =
      latest?.payload?.sourceDecision &&
      typeof latest.payload.sourceDecision === "object" &&
      !Array.isArray(latest.payload.sourceDecision)
        ? (latest.payload.sourceDecision as Record<string, unknown>)
        : undefined;
    expect(sourceDecision?.reason).toBe("incoming_source_disabled");
  });

  test("custom dispatch chain source can override default chain planning", () => {
    const customDispatchSource: SkillCascadeChainSource = {
      source: "dispatch",
      fromDispatch: () => ({
        source: "dispatch",
        steps: [
          {
            id: "custom-1:planning",
            skill: "planning",
            consumes: [],
            produces: ["execution_steps"],
          },
        ],
        unresolvedConsumes: [],
      }),
    };
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("custom-dispatch-source"),
      config: createConfig("assist"),
      skillCascadeChainSources: [customDispatchSource],
    });
    const sessionId = "skill-cascade-custom-source-1";

    seedPlanningDispatch(runtime, sessionId);
    runtime.skills.prepareDispatch(sessionId, "Plan and execute the refactor end-to-end");

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent).toBeDefined();
    expect(intent?.steps.length).toBe(1);
    expect(intent?.steps[0]?.id).toBe("custom-1:planning");
    expect(intent?.steps[0]?.skill).toBe("planning");
  });

  test("custom dispatch source still keeps default compose source behavior", () => {
    const customDispatchSource: SkillCascadeChainSource = {
      source: "dispatch",
      fromDispatch: () => ({
        source: "dispatch",
        steps: [
          {
            id: "custom-1:planning",
            skill: "planning",
            consumes: [],
            produces: ["execution_steps"],
          },
        ],
        unresolvedConsumes: [],
      }),
    };
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("custom-dispatch-source-compose"),
      config: createConfig("assist"),
      skillCascadeChainSources: [customDispatchSource],
    });
    const sessionId = "skill-cascade-custom-source-compose-1";

    runtime.context.onTurnStart(sessionId, 1);
    const activated = runtime.skills.activate(sessionId, "compose");
    expect(activated.ok).toBe(true);
    const completion = runtime.skills.complete(sessionId, {
      compose_analysis: "request_summary: compose source should remain available",
      compose_plan: "explore then plan",
      skill_sequence: [
        {
          id: "T1",
          skill: "exploration",
          consumes: [],
          expected_outputs: ["architecture_map", "key_modules", "unknowns"],
        },
      ],
    });
    expect(completion.ok).toBe(true);

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("compose");
    expect(intent?.steps[0]?.skill).toBe("exploration");
  });

  test("running dispatch intent keeps current chain when active skill is still running", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("dispatch-running-keep"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-dispatch-running-1";

    seedPlanningDispatch(runtime, sessionId);
    runtime.skills.prepareDispatch(sessionId, "Plan and execute the refactor end-to-end");
    const before = runtime.skills.getCascadeIntent(sessionId);
    expect(before).toBeDefined();
    expect(before?.source).toBe("dispatch");
    expect(before?.status).toBe("running");
    expect(runtime.skills.getActive(sessionId)?.name).toBe(before?.steps[before.cursor]?.skill);

    runtime.context.onTurnStart(sessionId, 2);
    runtime.skills.setNextSelection(sessionId, [
      {
        name: "planning",
        score: 20,
        reason: "semantic:planning request",
        breakdown: [{ signal: "semantic_match", term: "planning", delta: 20 }],
      },
    ]);
    runtime.skills.prepareDispatch(sessionId, "Re-dispatch while current skill is still running");

    const after = runtime.skills.getCascadeIntent(sessionId);
    expect(after?.id).toBe(before?.id);
    const latestKeep = findLatestEvent(runtime, sessionId, "skill_cascade_overridden");
    expect(latestKeep).toBeDefined();
    expect(latestKeep?.payload?.reason).toBe("source_decision_keep");
    const sourceDecision =
      latestKeep?.payload?.sourceDecision &&
      typeof latestKeep.payload.sourceDecision === "object" &&
      !Array.isArray(latestKeep.payload.sourceDecision)
        ? (latestKeep.payload.sourceDecision as Record<string, unknown>)
        : undefined;
    expect(sourceDecision?.replace).toBe(false);
    expect(sourceDecision?.reason).toBe("existing_running_active_skill");
  });

  test("compose completion can replace dispatch chain by source priority", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("compose-priority"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-compose-1";

    runtime.context.onTurnStart(sessionId, 1);
    runtime.skills.setNextSelection(sessionId, [
      {
        name: "compose",
        score: 30,
        reason: "semantic:compose request",
        breakdown: [{ signal: "semantic_match", term: "compose", delta: 30 }],
      },
    ]);
    runtime.skills.prepareDispatch(sessionId, "Break task into multi-step execution chain");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("compose");

    const completion = runtime.skills.complete(sessionId, {
      compose_analysis: "request_summary: multi-step feature delivery",
      compose_plan: "explore then plan then patch",
      skill_sequence: [
        {
          id: "T1",
          skill: "exploration",
          consumes: [],
          expected_outputs: ["architecture_map", "key_modules", "unknowns"],
        },
        {
          id: "T2",
          skill: "planning",
          consumes: ["architecture_map", "key_modules", "unknowns"],
          expected_outputs: ["execution_steps"],
        },
      ],
    });
    expect(completion.ok).toBe(true);

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("compose");
    expect(intent?.steps.some((step) => step.skill === "exploration")).toBe(true);
    expect(intent?.steps.some((step) => step.skill === "planning")).toBe(true);
    const composeReplan = runtime.events
      .list(sessionId)
      .toReversed()
      .find((event) => {
        if (event.type !== "skill_cascade_replanned") return false;
        const payload =
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : null;
        return payload?.reason === "compose_sequence_promoted";
      });
    expect(composeReplan).toBeDefined();
    const payload =
      composeReplan?.payload &&
      typeof composeReplan.payload === "object" &&
      !Array.isArray(composeReplan.payload)
        ? (composeReplan.payload as Record<string, unknown>)
        : undefined;
    const sourceDecision =
      payload?.sourceDecision &&
      typeof payload.sourceDecision === "object" &&
      !Array.isArray(payload.sourceDecision)
        ? (payload.sourceDecision as Record<string, unknown>)
        : undefined;
    expect(sourceDecision).toBeDefined();
    expect(sourceDecision?.replace).toBe(true);
    expect(sourceDecision?.incomingSource).toBe("compose");
    if (intent?.status === "running") {
      expect(runtime.skills.getActive(sessionId)?.name).toBe(intent.steps[intent.cursor]?.skill);
    }
  });

  test("compose sequence normalizes legacy review_findings contracts", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("compose-review-findings-alias"),
      config: createConfig("assist"),
    });
    const sessionId = "skill-cascade-compose-review-findings-1";

    runtime.context.onTurnStart(sessionId, 1);
    expect(runtime.skills.activate(sessionId, "compose").ok).toBe(true);
    const composeCompletion = runtime.skills.complete(sessionId, {
      compose_analysis: "request_summary: normalize review findings contract",
      compose_plan: "review then planning",
      skill_sequence: [
        {
          id: "T1",
          skill: "review",
          consumes: ["md"],
          expected_outputs: ["review_findings"],
        },
        {
          id: "T2",
          skill: "planning",
          consumes: ["review_findings"],
          expected_outputs: ["execution_steps"],
        },
      ],
    });
    expect(composeCompletion.ok).toBe(true);

    const composeIntent = runtime.skills.getCascadeIntent(sessionId);
    expect(composeIntent?.source).toBe("compose");
    expect(composeIntent?.steps[0]?.produces).toContain("findings");
    expect(composeIntent?.steps[0]?.produces).not.toContain("review_findings");
    expect(composeIntent?.steps[1]?.consumes).toContain("findings");
    expect(composeIntent?.steps[1]?.consumes).not.toContain("review_findings");

    expect(runtime.skills.activate(sessionId, "review").ok).toBe(true);
    const reviewCompletion = runtime.skills.complete(
      sessionId,
      buildSkillOutputs(runtime, "review"),
    );
    expect(reviewCompletion.ok).toBe(true);

    const afterReview = runtime.skills.getCascadeIntent(sessionId);
    expect(afterReview?.cursor).toBe(1);
    expect(afterReview?.status).toBe("paused");
    const latestPaused = findLatestEvent(runtime, sessionId, "skill_cascade_paused");
    expect(latestPaused?.payload?.reason).toBe("await_manual_activation");
    const unresolvedConsumes = Array.isArray(latestPaused?.payload?.unresolvedConsumes)
      ? latestPaused?.payload?.unresolvedConsumes
      : [];
    expect(unresolvedConsumes).toEqual([]);
  });

  test("running compose intent is not replaced by lower-priority dispatch reroute", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("compose-preserve"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-compose-preserve-1";

    runtime.context.onTurnStart(sessionId, 1);
    runtime.skills.setNextSelection(sessionId, [
      {
        name: "compose",
        score: 30,
        reason: "semantic:compose request",
        breakdown: [{ signal: "semantic_match", term: "compose", delta: 30 }],
      },
    ]);
    runtime.skills.prepareDispatch(sessionId, "Break task into multi-step execution chain");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("compose");

    const composeCompletion = runtime.skills.complete(sessionId, {
      compose_analysis: "request_summary: keep compose cascade active",
      compose_plan: "explore then plan then patch",
      skill_sequence: [
        {
          id: "T1",
          skill: "exploration",
          consumes: [],
          expected_outputs: ["architecture_map", "key_modules", "unknowns"],
        },
        {
          id: "T2",
          skill: "planning",
          consumes: ["architecture_map", "key_modules", "unknowns"],
          expected_outputs: ["execution_steps"],
        },
      ],
    });
    expect(composeCompletion.ok).toBe(true);
    const before = runtime.skills.getCascadeIntent(sessionId);
    expect(before?.source).toBe("compose");
    expect(before?.status).toBe("running");

    runtime.context.onTurnStart(sessionId, 2);
    runtime.skills.setNextSelection(sessionId, [
      {
        name: "planning",
        score: 20,
        reason: "semantic:planning request",
        breakdown: [{ signal: "semantic_match", term: "planning", delta: 20 }],
      },
    ]);
    runtime.skills.prepareDispatch(sessionId, "Plan next steps");

    const after = runtime.skills.getCascadeIntent(sessionId);
    expect(after?.source).toBe("compose");
    expect(after?.status).toBe("running");
    expect(runtime.skills.getActive(sessionId)?.name).toBe(after?.steps[after.cursor]?.skill);
    const latestKeep = findLatestEvent(runtime, sessionId, "skill_cascade_overridden");
    expect(latestKeep).toBeDefined();
    expect(latestKeep?.payload?.reason).toBe("source_decision_keep");
    const sourceDecision =
      latestKeep?.payload?.sourceDecision &&
      typeof latestKeep.payload.sourceDecision === "object" &&
      !Array.isArray(latestKeep.payload.sourceDecision)
        ? (latestKeep.payload.sourceDecision as Record<string, unknown>)
        : undefined;
    expect(sourceDecision?.replace).toBe(false);
    expect(sourceDecision?.reason).toBe("incoming_lower_priority");
  });

  test("explicit cascade is not replaced by compose sequence unless explicitly prioritized", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("explicit-lock"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-explicit-lock-1";

    const started = runtime.skills.startCascade(sessionId, {
      steps: [{ skill: "compose" }, { skill: "planning" }],
    });
    expect(started.ok).toBe(true);
    expect(runtime.skills.getActive(sessionId)?.name).toBe("compose");

    const composeCompletion = runtime.skills.complete(sessionId, {
      compose_analysis: "request_summary: explicit chain should stay authoritative",
      compose_plan: "compose then planning",
      skill_sequence: [
        {
          id: "T1",
          skill: "exploration",
          consumes: [],
          expected_outputs: ["architecture_map", "key_modules", "unknowns"],
        },
      ],
    });
    expect(composeCompletion.ok).toBe(true);

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("explicit");
    expect(intent?.steps[1]?.skill).toBe("planning");
    if (intent?.status === "running") {
      expect(runtime.skills.getActive(sessionId)?.name).toBe("planning");
    }
  });

  test("explicit cascade can be replaced when explicit source is configured with lower priority", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("explicit-replaceable"),
      config: createConfig("auto", ["compose", "explicit", "dispatch"]),
    });
    const sessionId = "skill-cascade-explicit-replaceable-1";

    const started = runtime.skills.startCascade(sessionId, {
      steps: [{ skill: "compose" }, { skill: "planning" }],
    });
    expect(started.ok).toBe(true);
    expect(runtime.skills.getActive(sessionId)?.name).toBe("compose");

    const composeCompletion = runtime.skills.complete(sessionId, {
      compose_analysis: "request_summary: explicit chain may be replaced by compose",
      compose_plan: "compose then planning",
      skill_sequence: [
        {
          id: "T1",
          skill: "exploration",
          consumes: [],
          expected_outputs: ["architecture_map", "key_modules", "unknowns"],
        },
      ],
    });
    expect(composeCompletion.ok).toBe(true);

    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("compose");
    expect(intent?.steps.length ?? 0).toBeGreaterThan(0);
    expect(intent?.steps.some((step) => step.skill === "planning")).toBe(false);
  });

  test("cascade intent is recoverable from event stream", () => {
    const workspace = createWorkspace("recover");
    const config = createConfig("assist");
    const sessionId = "skill-cascade-recover-1";

    const runtimeA = new BrewvaRuntime({ cwd: workspace, config });
    seedPlanningDispatch(runtimeA, sessionId);
    runtimeA.skills.prepareDispatch(sessionId, "Plan and execute the refactor end-to-end");
    const intentA = runtimeA.skills.getCascadeIntent(sessionId);
    expect(intentA).toBeDefined();

    const runtimeB = new BrewvaRuntime({ cwd: workspace, config });
    runtimeB.context.onTurnStart(sessionId, 2);
    const recovered = runtimeB.skills.getCascadeIntent(sessionId);
    expect(recovered).toBeDefined();
    expect(recovered?.id).toBe(intentA?.id);
    expect(recovered?.status).toBe(intentA?.status);
    expect(recovered?.steps.length).toBe(intentA?.steps.length);
  });
});
