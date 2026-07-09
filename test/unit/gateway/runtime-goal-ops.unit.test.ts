import { describe, expect, test } from "bun:test";
import { buildGoalContinuationPayload } from "@brewva/brewva-vocabulary/goal";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("hosted goal runtime ops", () => {
  test("starts, replaces, pauses, resumes, clears, and replays goal state from tape", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "goal-runtime-session";

    const started = runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Implement /goal",
      tokenBudget: 1_000,
      now: 100,
    });
    expect(started.ok).toBe(true);
    expect(runtime.ops.goal.state.get(sessionId)).toMatchObject({
      objective: "Implement /goal",
      status: "active",
      tokenBudget: 1_000,
    });

    const replaced = runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Implement /goal with channel parity",
      tokenBudget: 2_000,
      now: 200,
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) {
      throw new Error(replaced.reason);
    }
    expect(replaced.eventType).toBe("goal.replaced");
    expect(runtime.ops.goal.state.get(sessionId)).toMatchObject({
      objective: "Implement /goal with channel parity",
      replacementOf: started.goal?.id,
      status: "active",
    });

    expect(runtime.ops.goal.lifecycle.pause(sessionId, { reason: "reload", now: 300 }).ok).toBe(
      true,
    );
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("paused");
    expect(runtime.ops.goal.lifecycle.resume(sessionId, { now: 400 }).ok).toBe(true);
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("active");

    runtime.ops.goal.usage.observe(sessionId, {
      tokens: 512,
      elapsedMs: 1_000,
      turnId: "turn-1",
      now: 500,
    });
    expect(runtime.ops.goal.state.get(sessionId)?.usage.tokens).toBe(512);

    expect(runtime.ops.goal.lifecycle.clear(sessionId, { reason: "operator", now: 600 }).ok).toBe(
      true,
    );
    expect(runtime.ops.goal.state.get(sessionId)).toBeNull();

    expect(runtime.ops.events.records.query(sessionId, { type: "goal.replaced" })).toHaveLength(1);
  });

  test("budget-limits active goals when observed tokens reach the configured budget", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "goal-budget-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Stay within budget",
      tokenBudget: 10,
      now: 100,
    });
    const result = runtime.ops.goal.usage.observe(sessionId, {
      tokens: 10,
      elapsedMs: 100,
      turnId: "turn-budget",
      now: 200,
    });

    expect(result.ok).toBe(true);
    expect(result.goal?.status).toBe("budget_limited");
    expect(
      runtime.ops.events.records.query(sessionId, { type: "goal.budget_limited" }),
    ).toHaveLength(1);
  });

  test("caps active goals at the configured max-turns and resets the count on continue", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "goal-max-turns-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Cap the loop",
      maxTurns: 2,
      now: 100,
    });
    runtime.ops.goal.usage.observe(sessionId, { tokens: 1, elapsedMs: 1, turnId: "t1", now: 200 });
    const second = runtime.ops.goal.usage.observe(sessionId, {
      tokens: 1,
      elapsedMs: 1,
      turnId: "t2",
      now: 300,
    });

    expect(second.ok).toBe(true);
    expect(second.goal?.status).toBe("max_turns");
    expect(runtime.ops.events.records.query(sessionId, { type: "goal.max_turns" })).toHaveLength(1);

    const continued = runtime.ops.goal.lifecycle.continueGoal(sessionId, { now: 400 });
    expect(continued.ok).toBe(true);
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("active");
    expect(runtime.ops.goal.state.get(sessionId)?.usage.goalTurnCount).toBe(0);
  });

  test("records queued continuations with the provided deterministic timestamp", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "goal-continuation-clock-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Queue with deterministic time",
      now: 100,
    });
    const goal = runtime.ops.goal.state.get(sessionId);
    expect(goal).not.toBeNull();

    const result = runtime.ops.goal.continuation.recordQueued(
      sessionId,
      buildGoalContinuationPayload(goal!, "continue", { now: 250 }),
    );

    expect(result.ok).toBe(true);
    const queued = runtime.ops.events.records.query(sessionId, {
      type: "goal.continuation.queued",
    })[0];
    expect(queued?.timestamp).toBe(250);
    expect(queued?.payload?.now).toBe(250);
    expect(queued?.payload?.continuationId).toBe(
      "goal-continuation:goal-continuation-clock-session:250:1",
    );
  });

  test("requires three consecutive matching blocker observations before terminal block", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "goal-block-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Finish without guessing",
      now: 100,
    });

    const first = runtime.ops.goal.lifecycle.block(sessionId, {
      reason: "same missing external credential",
      evidence: ["credential prompt unavailable"],
      now: 200,
      turnId: "turn-1",
    });
    const second = runtime.ops.goal.lifecycle.block(sessionId, {
      reason: "same missing external credential",
      evidence: ["credential prompt unavailable"],
      now: 300,
      turnId: "turn-2",
    });
    const third = runtime.ops.goal.lifecycle.block(sessionId, {
      reason: "same missing external credential",
      evidence: ["credential prompt unavailable"],
      now: 400,
      turnId: "turn-3",
    });

    expect(first).toMatchObject({ ok: false, reason: "block_threshold_not_met", count: 1 });
    expect(second).toMatchObject({ ok: false, reason: "block_threshold_not_met", count: 2 });
    expect(third).toMatchObject({ ok: true, count: 3 });
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("blocked");
  });

  test("deduplicates repeated blocker observations within the same goal turn", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "goal-block-same-turn-session";

    const started = runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Do not count repeated tool calls as separate goal turns",
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

    const first = runtime.ops.goal.lifecycle.block(sessionId, {
      reason: "same missing access",
      evidence: ["approval not granted"],
      now: 200,
    });
    const repeated = runtime.ops.goal.lifecycle.block(sessionId, {
      reason: "same missing access",
      evidence: ["approval not granted"],
      now: 201,
    });

    expect(first).toMatchObject({ ok: false, reason: "block_threshold_not_met", count: 1 });
    expect(repeated).toMatchObject({ ok: false, reason: "block_threshold_not_met", count: 1 });
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("active");
  });

  test("does not carry blocker observations across replaced goals", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "goal-block-replacement-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Original goal",
      now: 100,
    });
    runtime.ops.goal.lifecycle.block(sessionId, {
      reason: "same missing access",
      evidence: ["approval not granted"],
      turnId: "turn-1",
      now: 200,
    });
    runtime.ops.goal.lifecycle.block(sessionId, {
      reason: "same missing access",
      evidence: ["approval not granted"],
      turnId: "turn-2",
      now: 300,
    });

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Replacement goal",
      now: 400,
    });
    const replacementFirstBlock = runtime.ops.goal.lifecycle.block(sessionId, {
      reason: "same missing access",
      evidence: ["approval not granted"],
      turnId: "turn-3",
      now: 500,
    });

    expect(replacementFirstBlock).toMatchObject({
      ok: false,
      reason: "block_threshold_not_met",
      count: 1,
    });
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("active");
  });
});
