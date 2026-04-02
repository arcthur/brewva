import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  SCHEDULE_EVENT_TYPE,
  SchedulerService,
  buildScheduleIntentCancelledEvent,
  buildScheduleIntentCreatedEvent,
  parseScheduleIntentEvent,
} from "@brewva/brewva-runtime";
import {
  computeExpectedRecurringJitteredNextRunAt,
  createSchedulerConfig,
  createWorkspace,
  schedulerRuntimePort,
} from "./scheduler-service.helpers.js";

describe("scheduler service projection contract", () => {
  test("keeps append order for same-timestamp events during replay", async () => {
    const workspace = createWorkspace("same-timestamp-order");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "session-same-timestamp-order";
    const intentId = "intent-same-timestamp-order";
    const timestamp = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const runAt = timestamp + 120_000;

    const createRow = {
      id: "evt_1735689600000_zzzzzzzz",
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      timestamp,
      payload: buildScheduleIntentCreatedEvent({
        intentId,
        parentSessionId: sessionId,
        reason: "created-first",
        continuityMode: "inherit",
        runAt,
        nextRunAt: runAt,
        maxRuns: 1,
      }),
    };
    const cancelRow = {
      id: "evt_1735689600000_aaaaaaaa",
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      timestamp,
      payload: buildScheduleIntentCancelledEvent({
        intentId,
        parentSessionId: sessionId,
        reason: "cancelled-second",
        continuityMode: "inherit",
        runAt,
        maxRuns: 1,
      }),
    };
    const encodedSessionId = Buffer.from(sessionId, "utf8").toString("base64url");
    const eventsFilePath = join(
      workspace,
      runtime.config.infrastructure.events.dir,
      `sess_${encodedSessionId}.jsonl`,
    );
    writeFileSync(eventsFilePath, `${JSON.stringify(createRow)}\n${JSON.stringify(cancelRow)}\n`);

    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();
    const state = scheduler.snapshot().intents.find((intent) => intent.intentId === intentId);
    scheduler.stop();

    expect(state?.status).toBe("cancelled");
    expect(state?.reason).toBe("cancelled-second");
    expect(state?.nextRunAt).toBeUndefined();
  });

  test("updates active intent schedule targets and emits intent_updated", async () => {
    const workspace = createWorkspace("update-intent");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.minIntervalMs = 60_000;
      }),
    });
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      intentId: "intent-update-cron",
      parentSessionId: "session-update",
      reason: "initial",
      continuityMode: "inherit",
      runAt: Date.now() + 300_000,
      maxRuns: 5,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const updated = scheduler.updateIntent({
      parentSessionId: "session-update",
      intentId: "intent-update-cron",
      reason: "updated",
      cron: "*/20 * * * *",
      timeZone: "Asia/Shanghai",
      maxRuns: 8,
    });
    scheduler.stop();

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.intent.reason).toBe("updated");
    expect(updated.intent.cron).toBe("*/20 * * * *");
    expect(updated.intent.timeZone).toBe("Asia/Shanghai");
    expect(updated.intent.maxRuns).toBe(8);
    expect(updated.intent.runAt).toBeUndefined();
    const expectedNextRunAt = computeExpectedRecurringJitteredNextRunAt({
      intentId: "intent-update-cron",
      cronExpression: "*/20 * * * *",
      afterMs: Date.now() + runtime.config.schedule.minIntervalMs - 1,
      timeZone: "Asia/Shanghai",
    });
    expect(typeof expectedNextRunAt).toBe("number");
    if (typeof expectedNextRunAt !== "number") return;
    expect(updated.intent.nextRunAt).toBe(expectedNextRunAt);

    const events = runtime.events.query("session-update", { type: SCHEDULE_EVENT_TYPE });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_updated");
  });

  test("updates cron intent timeZone without changing the cron expression", async () => {
    const workspace = createWorkspace("update-timezone-only");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.minIntervalMs = 60_000;
      }),
    });

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      intentId: "intent-update-timezone-only",
      parentSessionId: "session-update-timezone-only",
      reason: "timezone only",
      continuityMode: "inherit",
      cron: "0 9 * * *",
      timeZone: "Asia/Shanghai",
      maxRuns: 3,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const updated = scheduler.updateIntent({
      parentSessionId: "session-update-timezone-only",
      intentId: "intent-update-timezone-only",
      timeZone: "America/New_York",
    });
    scheduler.stop();

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.intent.cron).toBe("0 9 * * *");
    expect(updated.intent.timeZone).toBe("America/New_York");
    const expectedNextRunAt = computeExpectedRecurringJitteredNextRunAt({
      intentId: "intent-update-timezone-only",
      cronExpression: "0 9 * * *",
      afterMs: nowMs + runtime.config.schedule.minIntervalMs - 1,
      timeZone: "America/New_York",
    });
    expect(typeof expectedNextRunAt).toBe("number");
    if (typeof expectedNextRunAt !== "number") return;
    expect(updated.intent.nextRunAt).toBe(expectedNextRunAt);
  });

  test("replay prefers event-carried nextRunAt for cron intents", async () => {
    const workspace = createWorkspace("replay-authoritative-next-run");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.minIntervalMs = 60_000;
      }),
    });
    const sessionId = "session-replay-authoritative-next-run";
    const forcedNextRunAt = Date.UTC(2026, 0, 1, 12, 34, 56, 789);

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-replay-authoritative-next-run",
        parentSessionId: sessionId,
        reason: "respect persisted nextRunAt",
        continuityMode: "inherit",
        cron: "*/5 * * * *",
        timeZone: "UTC",
        nextRunAt: forcedNextRunAt,
        maxRuns: 4,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-replay-authoritative-next-run");
    scheduler.stop();

    expect(state?.nextRunAt).toBe(forcedNextRunAt);
  });

  test("rejects created replay payloads that omit nextRunAt", async () => {
    const workspace = createWorkspace("replay-missing-next-run");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "session-replay-missing-next-run";
    const runAt = Date.UTC(2026, 0, 1, 0, 5, 0, 0);

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: {
        schema: "brewva.schedule.v1",
        kind: "intent_created",
        intentId: "intent-replay-missing-next-run",
        parentSessionId: sessionId,
        reason: "missing nextRunAt should be rejected",
        continuityMode: "inherit",
        runAt,
        maxRuns: 1,
      } as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-replay-missing-next-run");
    scheduler.stop();

    expect(state).toBeUndefined();
  });

  test("rejects updates when the target intent is not active", async () => {
    const workspace = createWorkspace("update-not-active");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-update-not-active",
      reason: "initial",
      continuityMode: "inherit",
      runAt: Date.now() + 180_000,
      maxRuns: 3,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const cancelled = scheduler.cancelIntent({
      parentSessionId: "session-update-not-active",
      intentId: created.intent.intentId,
    });
    expect(cancelled.ok).toBe(true);

    const updated = scheduler.updateIntent({
      parentSessionId: "session-update-not-active",
      intentId: created.intent.intentId,
      reason: "should fail",
    });
    scheduler.stop();

    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.error).toBe("intent_not_active");
    }
  });

  test("rejects timeZone-only updates for runAt intents", async () => {
    const workspace = createWorkspace("update-timezone-runat-guard");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-update-timezone-runat-guard",
      reason: "runAt intent",
      continuityMode: "inherit",
      runAt: Date.now() + 180_000,
      maxRuns: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const updated = scheduler.updateIntent({
      parentSessionId: "session-update-timezone-runat-guard",
      intentId: created.intent.intentId,
      timeZone: "Asia/Shanghai",
    });
    scheduler.stop();

    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.error).toBe("timeZone_requires_cron");
    }
  });
});
