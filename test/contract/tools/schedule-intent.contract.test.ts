import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId, parseScheduleIntentEvent } from "@brewva/brewva-runtime";
import { createScheduleIntentTool } from "@brewva/brewva-tools";
import {
  createScheduleToolRuntime,
  extractTextContent,
  fakeContext,
} from "./tools-flow.helpers.js";

describe("schedule_intent contract", () => {
  test("supports create, list, and cancel", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-intent-tool-");
    const sessionId = asBrewvaSessionId("s14");
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create",
      {
        action: "create",
        reason: "wait for CI",
        delayMs: 120_000,
        continuityMode: "inherit",
        maxRuns: 1,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const createText = extractTextContent(createResult);
    expect(createText).toContain("Schedule intent created.");

    const createdIntents = await runtime.inspect.schedule.listIntents({
      parentSessionId: sessionId,
    });
    expect(createdIntents.length).toBe(1);
    const createdIntentId = createdIntents[0]?.intentId;
    expect(typeof createdIntentId).toBe("string");
    if (!createdIntentId) return;

    const listResult = await tool.execute(
      "tc-schedule-list",
      {
        action: "list",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const listText = extractTextContent(listResult);
    expect(listText).toContain("[ScheduleIntents]");
    expect(listText).toContain(createdIntentId);

    const cancelResult = await tool.execute(
      "tc-schedule-cancel",
      {
        action: "cancel",
        intentId: createdIntentId,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const cancelText = extractTextContent(cancelResult);
    expect(cancelText).toContain("Schedule intent cancelled");

    const events = runtime.inspect.events.query(sessionId, { type: "schedule_intent" });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_created");
    expect(kinds).toContain("intent_cancelled");
  });

  test("create accepts a structured convergenceCondition", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-intent-predicate-tool-");
    const sessionId = asBrewvaSessionId("s14-predicate");
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-predicate",
      {
        action: "create",
        reason: "wait for task done phase",
        delayMs: 120_000,
        convergenceCondition: {
          kind: "task_phase",
          phase: "done",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const createText = extractTextContent(createResult);
    expect(createText).toContain("Schedule intent created.");

    const intents = await runtime.inspect.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents.length).toBe(1);
    expect(intents[0]?.convergenceCondition).toEqual({
      kind: "task_phase",
      phase: "done",
    });
  });

  test("create supports cron targets", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-intent-cron-tool-");
    const sessionId = asBrewvaSessionId("s14-cron");
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-cron",
      {
        action: "create",
        reason: "daily review",
        cron: "*/10 * * * *",
        timeZone: "Asia/Shanghai",
        maxRuns: 4,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const createText = extractTextContent(createResult);
    expect(createText).toContain("Schedule intent created.");
    expect(createText).toContain("cron: */10 * * * *");
    expect(createText).toContain("timeZone: Asia/Shanghai");

    const intents = await runtime.inspect.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents.length).toBe(1);
    expect(intents[0]?.cron).toBe("*/10 * * * *");
    expect(intents[0]?.timeZone).toBe("Asia/Shanghai");
    expect(intents[0]?.runAt).toBeUndefined();
    expect(typeof intents[0]?.nextRunAt).toBe("number");
  });

  test("supports the update action", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-intent-update-tool-");
    const sessionId = asBrewvaSessionId("s14-update");
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-for-update",
      {
        action: "create",
        reason: "wait for CI",
        delayMs: 120_000,
        maxRuns: 5,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const createText = extractTextContent(createResult);
    expect(createText).toContain("Schedule intent created.");

    const createdIntents = await runtime.inspect.schedule.listIntents({
      parentSessionId: sessionId,
    });
    expect(createdIntents.length).toBe(1);
    const intentId = createdIntents[0]?.intentId;
    if (!intentId) return;

    const updateResult = await tool.execute(
      "tc-schedule-update",
      {
        action: "update",
        intentId,
        reason: "switch to recurring monitor",
        cron: "*/15 * * * *",
        timeZone: "Asia/Shanghai",
        maxRuns: 8,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const updateText = extractTextContent(updateResult);
    expect(updateText).toContain("Schedule intent updated.");
    expect(updateText).toContain("cron: */15 * * * *");
    expect(updateText).toContain("timeZone: Asia/Shanghai");

    const intents = await runtime.inspect.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents.length).toBe(1);
    expect(intents[0]?.cron).toBe("*/15 * * * *");
    expect(intents[0]?.timeZone).toBe("Asia/Shanghai");
    expect(intents[0]?.maxRuns).toBe(8);
    expect(intents[0]?.runAt).toBeUndefined();

    const events = runtime.inspect.events.query(sessionId, { type: "schedule_intent" });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_updated");
  });

  test("update rejects blank reason and goalRef", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-intent-update-blank-tool-");
    const sessionId = asBrewvaSessionId("s14-update-blank");
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-for-update-blank",
      {
        action: "create",
        reason: "initial",
        delayMs: 120_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(createResult)).toContain("Schedule intent created.");

    const createdIntents = await runtime.inspect.schedule.listIntents({
      parentSessionId: sessionId,
    });
    const intentId = createdIntents[0]?.intentId;
    if (!intentId) return;

    const blankReasonResult = await tool.execute(
      "tc-schedule-update-blank-reason",
      {
        action: "update",
        intentId,
        reason: "   ",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(
      extractTextContent(blankReasonResult).includes(
        "Schedule intent update rejected (invalid_reason).",
      ),
    ).toBe(true);
    expect((blankReasonResult.details as { verdict?: string } | undefined)?.verdict).toBe("fail");

    const blankGoalRefResult = await tool.execute(
      "tc-schedule-update-blank-goal-ref",
      {
        action: "update",
        intentId,
        goalRef: "   ",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(
      extractTextContent(blankGoalRefResult).includes(
        "Schedule intent update rejected (invalid_goal_ref).",
      ),
    ).toBe(true);
    expect((blankGoalRefResult.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  test("update supports a timezone-only patch for cron intents", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-intent-update-timezone-only-tool-");
    const sessionId = asBrewvaSessionId("s14-update-timezone-only");
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-for-update-timezone-only",
      {
        action: "create",
        reason: "daily monitor",
        cron: "0 9 * * *",
        timeZone: "Asia/Shanghai",
        maxRuns: 5,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(createResult)).toContain("Schedule intent created.");

    const createdIntents = await runtime.inspect.schedule.listIntents({
      parentSessionId: sessionId,
    });
    const intentId = createdIntents[0]?.intentId;
    if (!intentId) return;

    const updateResult = await tool.execute(
      "tc-schedule-update-timezone-only",
      {
        action: "update",
        intentId,
        timeZone: "America/New_York",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const updateText = extractTextContent(updateResult);
    expect(updateText).toContain("Schedule intent updated.");
    expect(updateText).toContain("cron: 0 9 * * *");
    expect(updateText).toContain("timeZone: America/New_York");

    const intents = await runtime.inspect.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents.length).toBe(1);
    expect(intents[0]?.cron).toBe("0 9 * * *");
    expect(intents[0]?.timeZone).toBe("America/New_York");
  });

  test("rejects timeZone without cron", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-intent-timezone-guard-tool-");
    const sessionId = asBrewvaSessionId("s14-timezone-guard");
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-timezone-guard",
      {
        action: "create",
        reason: "invalid timezone usage",
        delayMs: 120_000,
        timeZone: "Asia/Shanghai",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const createText = extractTextContent(createResult);
    expect(createText).toContain("Schedule intent rejected (timeZone_requires_cron).");
    expect((createResult.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });
});
