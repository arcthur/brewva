import { describe, expect, test } from "bun:test";
import type {
  BrewvaHostCustomMessage,
  BrewvaHostCustomMessageDelivery,
} from "@brewva/brewva-substrate/host-api";
import { buildGoalContinuationPayload } from "@brewva/brewva-vocabulary/goal";
import { createGoalContinuationLifecycle } from "../../../packages/brewva-gateway/src/hosted/internal/session/goal-continuation.js";
import { enqueueGoalContinuation } from "../../../packages/brewva-gateway/src/utils/goal-continuation.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

function createLifecycleFixture(sessionId = "goal-continuation-session", now?: () => number) {
  const runtime = createRuntimeFixture();
  const sentMessages: Array<{
    customType: string;
    content: string;
    triggerTurn?: boolean;
    deliverAs?: string;
  }> = [];
  let pendingMessages = false;
  const lifecycle = createGoalContinuationLifecycle(
    {
      sendMessage: (
        message: BrewvaHostCustomMessage,
        options?: { triggerTurn?: boolean; deliverAs?: BrewvaHostCustomMessageDelivery },
      ) => {
        sentMessages.push({
          customType: message.customType,
          content: message.content,
          triggerTurn: options?.triggerTurn,
          deliverAs: options?.deliverAs,
        });
        pendingMessages = true;
      },
    } as never,
    runtime,
    now ? { now } : undefined,
  );
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
    },
    hasPendingMessages: () => pendingMessages,
  } as never;
  return {
    runtime,
    lifecycle,
    ctx,
    sentMessages,
    clearPendingMessages: () => {
      pendingMessages = false;
    },
  };
}

describe("goal continuation lifecycle", () => {
  test("enqueues continuations and prompts through the shared helper", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "goal-enqueue-helper-session";
    const prompts: Array<{ text: string; source?: string }> = [];

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Use one enqueue path",
      now: 100,
    });
    const goal = runtime.ops.goal.state.get(sessionId);
    expect(goal).not.toBeNull();

    const result = await enqueueGoalContinuation({
      sessionId,
      goal: goal!,
      now: 200,
      recordQueued: (targetSessionId, payload) =>
        runtime.ops.goal.continuation.recordQueued(targetSessionId, payload),
      prompt: async (parts, options) => {
        prompts.push({
          text: parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
          source: options?.source,
        });
      },
      promptOptions: { source: "channel" },
    });

    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ source: "channel" });
    expect(prompts[0]?.text).toContain("Use one enqueue path");
    expect(
      runtime.ops.events.records.query(sessionId, { type: "goal.continuation.queued" })[0]?.payload
        ?.now,
    ).toBe(200);
  });

  test("pauses active goals on session start instead of auto-resuming", async () => {
    const { runtime, lifecycle, ctx } = createLifecycleFixture();

    runtime.ops.goal.lifecycle.start("goal-continuation-session", {
      objective: "Pause on reload",
      now: 100,
    });

    await lifecycle.sessionStart?.({ type: "session_start" } as never, ctx);

    expect(runtime.ops.goal.state.get("goal-continuation-session")).toMatchObject({
      status: "paused",
      pausedReason: "session_start",
    });
  });

  test("records usage only for queued goal continuation turns", async () => {
    const { runtime, lifecycle, ctx } = createLifecycleFixture();
    const sessionId = "goal-continuation-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Count only goal-triggered turns",
      now: 100,
    });

    await lifecycle.turnEnd?.(
      {
        type: "turn_end",
        turnIndex: 1,
        message: { usage: { totalTokens: 25 } },
        toolResults: [],
      },
      ctx,
    );
    expect(runtime.ops.goal.state.get(sessionId)?.usage.tokens).toBe(0);

    const goal = runtime.ops.goal.state.get(sessionId);
    expect(goal).not.toBeNull();
    runtime.ops.goal.continuation.recordQueued(sessionId, {
      ...buildGoalContinuationPayload(goal!),
      continuationId: "continuation-1",
    });

    await lifecycle.turnEnd?.(
      {
        type: "turn_end",
        turnIndex: 2,
        message: { usage: { totalTokens: 25 } },
        toolResults: [],
      },
      ctx,
    );
    expect(runtime.ops.goal.state.get(sessionId)?.usage.tokens).toBe(25);

    await lifecycle.turnEnd?.(
      {
        type: "turn_end",
        turnIndex: 3,
        message: { usage: { totalTokens: 25 } },
        toolResults: [],
      },
      ctx,
    );
    expect(runtime.ops.goal.state.get(sessionId)?.usage.tokens).toBe(25);
  });

  test("queues active continuations and a single max-turns wrap-up follow-up", async () => {
    const nowValues = [200, 300, 400];
    const { runtime, lifecycle, ctx, sentMessages, clearPendingMessages } = createLifecycleFixture(
      "goal-continuation-session",
      () => nowValues.shift() ?? 999,
    );
    const sessionId = "goal-continuation-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Cap the loop",
      maxTurns: 1,
      now: 100,
    });

    await lifecycle.agentEnd?.({ type: "agent_end", messages: [] }, ctx);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ customType: "goal.continuation" });

    clearPendingMessages();
    await lifecycle.turnEnd?.(
      {
        type: "turn_end",
        turnIndex: 1,
        message: { usage: { totalTokens: 5 } },
        toolResults: [],
      },
      ctx,
    );
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("max_turns");

    await lifecycle.agentEnd?.({ type: "agent_end", messages: [] }, ctx);
    clearPendingMessages();
    await lifecycle.agentEnd?.({ type: "agent_end", messages: [] }, ctx);

    // Exactly one wrap-up despite two agentEnds (the single-send guard).
    expect(sentMessages.map((message) => message.customType)).toEqual([
      "goal.continuation",
      "goal.max_turns_wrap_up",
    ]);
  });

  test("queues active continuations and a single budget wrap-up follow-up", async () => {
    const nowValues = [200, 300, 400];
    const { runtime, lifecycle, ctx, sentMessages, clearPendingMessages } = createLifecycleFixture(
      "goal-continuation-session",
      () => nowValues.shift() ?? 999,
    );
    const sessionId = "goal-continuation-session";

    runtime.ops.goal.lifecycle.start(sessionId, {
      objective: "Drive follow-up",
      tokenBudget: 10,
      now: 100,
    });

    await lifecycle.agentEnd?.({ type: "agent_end", messages: [] }, ctx);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      customType: "goal.continuation",
      triggerTurn: true,
      deliverAs: "followUp",
    });
    expect(
      runtime.ops.events.records.query(sessionId, { type: "goal.continuation.queued" })[0]?.payload
        ?.now,
    ).toBe(200);

    clearPendingMessages();
    await lifecycle.turnEnd?.(
      {
        type: "turn_end",
        turnIndex: 1,
        message: { usage: { totalTokens: 10 } },
        toolResults: [],
      },
      ctx,
    );
    expect(runtime.ops.goal.state.get(sessionId)?.status).toBe("budget_limited");

    await lifecycle.agentEnd?.({ type: "agent_end", messages: [] }, ctx);
    clearPendingMessages();
    await lifecycle.agentEnd?.({ type: "agent_end", messages: [] }, ctx);

    expect(sentMessages.map((message) => message.customType)).toEqual([
      "goal.continuation",
      "goal.budget_wrap_up",
    ]);
  });
});
