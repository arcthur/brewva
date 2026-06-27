import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { createScheduleToolRuntime } from "./tools-flow.helpers.js";

describe("schedule intent create persists nextRunAt", () => {
  test("a cron intent carries a real next slot on create, shared with the projection", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-create-cron-");
    const sessionId = asBrewvaSessionId("schedule-create-cron-session");

    const created = await runtime.capabilities.schedule.intents.create(sessionId, {
      reason: "daily report",
      cron: "0 9 * * *",
      timeZone: "UTC",
      maxRuns: 100,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(typeof created.intent.nextRunAt).toBe("number");
    if (typeof created.intent.nextRunAt === "number") {
      const slot = new Date(created.intent.nextRunAt);
      expect(slot.getUTCHours()).toBe(9); // a real cron slot, not a +60s placeholder
      expect(slot.getUTCMinutes()).toBeLessThanOrEqual(15); // jitter cap
    }

    // The projection returns the SAME authoritative persisted value rather than
    // re-deriving its own — the two read models cannot drift.
    const listed = await runtime.capabilities.schedule.intents.list({ parentSessionId: sessionId });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.nextRunAt).toBe(created.intent.nextRunAt);
  });

  test("a partial update without cron keeps the recurring intent's next slot", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-update-partial-");
    const sessionId = asBrewvaSessionId("schedule-update-partial-session");

    const created = await runtime.capabilities.schedule.intents.create(sessionId, {
      reason: "daily report",
      cron: "0 9 * * *",
      timeZone: "UTC",
      maxRuns: 100,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Update only maxRuns — the patch carries no schedule fields.
    await runtime.capabilities.schedule.intents.update(sessionId, {
      intentId: created.intent.intentId,
      maxRuns: 200,
    });

    const listed = await runtime.capabilities.schedule.intents.list({ parentSessionId: sessionId });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.maxRuns).toBe(200);
    // The recurrence slot survives the unrelated update (regression: it was wiped).
    expect(typeof listed[0]?.nextRunAt).toBe("number");
    if (typeof listed[0]?.nextRunAt === "number") {
      expect(new Date(listed[0].nextRunAt).getUTCHours()).toBe(9);
    }
  });

  test("a one-shot intent carries its runAt as nextRunAt on create", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-create-oneshot-");
    const sessionId = asBrewvaSessionId("schedule-create-oneshot-session");
    const runAt = Date.now() + 3_600_000;

    const created = await runtime.capabilities.schedule.intents.create(sessionId, {
      reason: "one shot",
      runAt,
      maxRuns: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.intent.nextRunAt).toBe(runAt);
  });
});
