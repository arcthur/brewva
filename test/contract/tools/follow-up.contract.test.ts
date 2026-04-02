import { describe, expect, test } from "bun:test";
import { createFollowUpTool } from "@brewva/brewva-tools";
import {
  createScheduleToolRuntime,
  extractTextContent,
  fakeContext,
} from "./tools-flow.helpers.js";

describe("follow_up contract", () => {
  test("supports create after, list, and cancel", async () => {
    const runtime = createScheduleToolRuntime("brewva-follow-up-after-tool-");
    const sessionId = "follow-up-after-session";
    const tool = createFollowUpTool({ runtime });

    const createResult = await tool.execute(
      "tc-follow-up-create-after",
      {
        action: "create",
        reason: "check deploy status",
        after: "20m",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(createResult)).toContain("Follow-up created.");

    const intents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.cron).toBeUndefined();
    expect(typeof intents[0]?.runAt).toBe("number");

    const listResult = await tool.execute(
      "tc-follow-up-list",
      {
        action: "list",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const listText = extractTextContent(listResult);
    expect(listText).toContain("[FollowUps]");
    expect(listText).toContain(intents[0]?.intentId ?? "");

    const cancelResult = await tool.execute(
      "tc-follow-up-cancel",
      {
        action: "cancel",
        intentId: intents[0]?.intentId,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(cancelResult)).toContain("Follow-up cancelled");
  });

  test("create every compiles to recurring schedule_intent semantics with bounded default runs", async () => {
    const runtime = createScheduleToolRuntime("brewva-follow-up-every-tool-");
    const sessionId = "follow-up-every-session";
    const tool = createFollowUpTool({ runtime });

    const createResult = await tool.execute(
      "tc-follow-up-create-every",
      {
        action: "create",
        reason: "poll rollout health",
        every: "5m",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(createResult)).toContain("Follow-up created.");

    const intents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.cron).toBe("*/5 * * * *");
    expect(intents[0]?.maxRuns).toBe(12);
    expect(intents[0]?.continuityMode).toBe("inherit");
  });

  test("rejects invalid duration grammar deterministically", async () => {
    const runtime = createScheduleToolRuntime("brewva-follow-up-invalid-tool-");
    const tool = createFollowUpTool({ runtime });

    const invalidAfter = await tool.execute(
      "tc-follow-up-invalid-after",
      {
        action: "create",
        reason: "invalid after",
        after: "0m",
      },
      undefined,
      undefined,
      fakeContext("follow-up-invalid-after-session"),
    );
    expect(extractTextContent(invalidAfter)).toContain("Follow-up rejected (invalid_after).");

    const invalidEvery = await tool.execute(
      "tc-follow-up-invalid-every",
      {
        action: "create",
        reason: "invalid every",
        every: "5d",
      },
      undefined,
      undefined,
      fakeContext("follow-up-invalid-every-session"),
    );
    expect(extractTextContent(invalidEvery)).toContain("Follow-up rejected (invalid_every).");
  });

  test("rejects recurring intervals that cannot be represented without cron drift", async () => {
    const runtime = createScheduleToolRuntime("brewva-follow-up-unsupported-tool-");
    const tool = createFollowUpTool({ runtime });

    const result = await tool.execute(
      "tc-follow-up-unsupported-every",
      {
        action: "create",
        reason: "unsupported cadence",
        every: "90m",
      },
      undefined,
      undefined,
      fakeContext("follow-up-unsupported-session"),
    );

    expect(extractTextContent(result)).toContain(
      "Follow-up rejected (unsupported_every_interval).",
    );
  });
});
