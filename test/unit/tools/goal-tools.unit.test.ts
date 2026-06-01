import { describe, expect, test } from "bun:test";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";
import { createGoalTools } from "@brewva/brewva-tools/workflow";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";

const toolContext = (sessionId: string) =>
  ({
    sessionManager: {
      getSessionId: () => sessionId,
    },
  }) as never;

describe("goal managed tools", () => {
  test("ships get_goal and update_goal in the default managed bundle as control-plane tools", () => {
    const runtime = createBundledToolRuntime(createRuntimeFixture());
    const tools = buildBrewvaTools({ runtime });
    const goalTools = tools.filter(
      (tool) => tool.name === "get_goal" || tool.name === "update_goal",
    );

    expect(goalTools.map((tool) => tool.name).toSorted()).toEqual(["get_goal", "update_goal"]);
    expect(goalTools.map((tool) => getBrewvaToolMetadata(tool)?.surface)).toEqual([
      "control_plane",
      "control_plane",
    ]);
  });

  test("get_goal fails closed when no active goal exists and reads active goal state", async () => {
    const runtime = createRuntimeFixture();
    const [getGoal] = createGoalTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "goal-tool-session";

    expect(
      (
        await getGoal!.execute(
          "tool-1",
          {},
          undefined as never,
          undefined as never,
          toolContext(sessionId),
        )
      ).outcome.kind,
    ).toBe("err");

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Expose active goal to the model",
      tokenBudget: 100,
      now: 100,
    });
    const result = await getGoal!.execute(
      "tool-2",
      {},
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Expose active goal to the model",
    );
  });

  test("update_goal completes active goals and enforces blocked evidence policy", async () => {
    const runtime = createRuntimeFixture();
    const [, updateGoal] = createGoalTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "goal-update-tool-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Finish correctly",
      now: 100,
    });

    const blockedWithoutEvidence = await updateGoal!.execute(
      "tool-1",
      { status: "blocked", reason: "missing access" },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(blockedWithoutEvidence.outcome.kind).toBe("err");

    const complete = await updateGoal!.execute(
      "tool-2",
      { status: "complete", evidence: ["tests passed"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(complete.outcome.kind).toBe("ok");
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("complete");
  });

  test("update_goal cannot block a goal by repeating evidence in one continuation turn", async () => {
    const runtime = createRuntimeFixture();
    const [, updateGoal] = createGoalTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "goal-update-tool-block-threshold-session";

    const started = runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Do not count repeated tool calls as separate turns",
      now: 100,
    });
    if (!started.ok || !started.goal) {
      throw new Error("goal_start_failed");
    }
    runtime.ops.goal.continuation.recordQueued(sessionId, {
      goalId: started.goal.id,
      objective: started.goal.objective,
      tokenBudget: null,
      usage: started.goal.usage,
      kind: "continue",
      continuationId: "continuation-1",
    });

    for (const toolCallId of ["tool-1", "tool-2", "tool-3"]) {
      const result = await updateGoal!.execute(
        toolCallId,
        {
          status: "blocked",
          reason: "missing access",
          evidence: ["approval not granted"],
        },
        undefined as never,
        undefined as never,
        toolContext(sessionId),
      );
      expect(result.outcome.kind).toBe("err");
    }

    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("active");
  });
});
