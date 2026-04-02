import { describe, expect, test } from "bun:test";
import {
  BrewvaRuntime,
  SCHEDULE_EVENT_TYPE,
  SchedulerService,
  buildScheduleIntentCreatedEvent,
  getNextCronRunAt,
  parseCronExpression,
} from "@brewva/brewva-runtime";
import {
  createSchedulerConfig,
  computeExpectedRecurringJitteredNextRunAt,
  createWorkspace,
  schedulerRuntimePort,
} from "./scheduler-service.helpers.js";

describe("scheduler service limit contract", () => {
  test("enforces active intent limits", async () => {
    const workspace = createWorkspace("limits");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.maxActiveIntentsPerSession = 1;
        config.schedule.maxActiveIntentsGlobal = 2;
      }),
    });

    const scheduler = new SchedulerService({ runtime: schedulerRuntimePort(runtime) });
    await scheduler.recover();

    const now = Date.now() + 120_000;
    const createdA = scheduler.createIntent({
      parentSessionId: "session-a",
      reason: "limit-A",
      continuityMode: "inherit",
      runAt: now,
    });
    expect(createdA.ok).toBe(true);

    const rejectedSession = scheduler.createIntent({
      parentSessionId: "session-a",
      reason: "limit-A2",
      continuityMode: "inherit",
      runAt: now + 10_000,
    });
    expect(rejectedSession.ok).toBe(false);
    if (!rejectedSession.ok) {
      expect(rejectedSession.error).toBe("max_active_intents_per_session_exceeded");
    }

    const createdB = scheduler.createIntent({
      parentSessionId: "session-b",
      reason: "limit-B",
      continuityMode: "inherit",
      runAt: now + 20_000,
    });
    expect(createdB.ok).toBe(true);

    const rejectedGlobal = scheduler.createIntent({
      parentSessionId: "session-c",
      reason: "limit-C",
      continuityMode: "inherit",
      runAt: now + 30_000,
    });
    expect(rejectedGlobal.ok).toBe(false);
    if (!rejectedGlobal.ok) {
      expect(rejectedGlobal.error).toBe("max_active_intents_global_exceeded");
    }

    scheduler.stop();
  });

  test("creates cron intents with computed nextRunAt", async () => {
    const workspace = createWorkspace("cron-create");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.minIntervalMs = 60_000;
      }),
    });

    const nowMs = Date.UTC(2026, 0, 1, 0, 1, 30, 0);
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      intentId: "intent-cron-create",
      parentSessionId: "session-cron-create",
      reason: "cron create",
      continuityMode: "inherit",
      cron: "*/5 * * * *",
      maxRuns: 5,
    });
    scheduler.stop();

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.intent.cron).toBe("*/5 * * * *");
    expect(typeof created.intent.timeZone).toBe("string");
    expect(typeof created.intent.nextRunAt).toBe("number");
    if (typeof created.intent.nextRunAt === "number") {
      const minBase = nowMs + runtime.config.schedule.minIntervalMs - 1;
      const expectedNextRunAt = computeExpectedRecurringJitteredNextRunAt({
        intentId: "intent-cron-create",
        cronExpression: "*/5 * * * *",
        afterMs: minBase,
        timeZone: created.intent.timeZone,
      });
      expect(typeof expectedNextRunAt).toBe("number");
      if (typeof expectedNextRunAt !== "number") return;
      expect(created.intent.nextRunAt).toBe(expectedNextRunAt);
    }
  });

  test("creates cron intents with explicit timeZone", async () => {
    const workspace = createWorkspace("cron-timezone");
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
      intentId: "intent-cron-timezone",
      parentSessionId: "session-cron-timezone",
      reason: "cron with timezone",
      continuityMode: "inherit",
      cron: "0 9 * * *",
      timeZone: "Asia/Shanghai",
      maxRuns: 2,
    });
    scheduler.stop();

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.intent.timeZone).toBe("Asia/Shanghai");
    const expectedNextRunAt = computeExpectedRecurringJitteredNextRunAt({
      intentId: "intent-cron-timezone",
      cronExpression: "0 9 * * *",
      afterMs: nowMs + runtime.config.schedule.minIntervalMs - 1,
      timeZone: "Asia/Shanghai",
    });
    expect(typeof expectedNextRunAt).toBe("number");
    if (typeof expectedNextRunAt !== "number") return;
    expect(created.intent.nextRunAt).toBe(expectedNextRunAt);
  });

  test("jitter distributes same-cron intents away from the shared exact boundary", async () => {
    const workspace = createWorkspace("cron-anti-herd");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.minIntervalMs = 60_000;
      }),
    });

    const nowMs = Date.UTC(2026, 0, 1, 0, 1, 30, 0);
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      enableExecution: false,
    });
    await scheduler.recover();

    const createdA = scheduler.createIntent({
      intentId: "intent-cron-anti-herd-a",
      parentSessionId: "session-cron-anti-herd",
      reason: "cron anti-herd A",
      continuityMode: "inherit",
      cron: "*/5 * * * *",
      maxRuns: 5,
    });
    const createdB = scheduler.createIntent({
      intentId: "intent-cron-anti-herd-b",
      parentSessionId: "session-cron-anti-herd",
      reason: "cron anti-herd B",
      continuityMode: "inherit",
      cron: "*/5 * * * *",
      maxRuns: 5,
    });
    scheduler.stop();

    expect(createdA.ok).toBe(true);
    expect(createdB.ok).toBe(true);
    if (!createdA.ok || !createdB.ok) return;

    const minBase = nowMs + runtime.config.schedule.minIntervalMs - 1;
    const parsed = parseCronExpression("*/5 * * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const exactNextRunAt = getNextCronRunAt(parsed.expression, minBase);
    expect(typeof exactNextRunAt).toBe("number");
    if (exactNextRunAt === undefined) return;

    const expectedNextRunAtA = computeExpectedRecurringJitteredNextRunAt({
      intentId: "intent-cron-anti-herd-a",
      cronExpression: "*/5 * * * *",
      afterMs: minBase,
      timeZone: createdA.intent.timeZone,
    });
    const expectedNextRunAtB = computeExpectedRecurringJitteredNextRunAt({
      intentId: "intent-cron-anti-herd-b",
      cronExpression: "*/5 * * * *",
      afterMs: minBase,
      timeZone: createdB.intent.timeZone,
    });
    expect(typeof expectedNextRunAtA).toBe("number");
    expect(typeof expectedNextRunAtB).toBe("number");
    if (expectedNextRunAtA === undefined || expectedNextRunAtB === undefined) return;

    expect(createdA.intent.nextRunAt).toBe(expectedNextRunAtA);
    expect(createdB.intent.nextRunAt).toBe(expectedNextRunAtB);
    expect(createdA.intent.nextRunAt).toBeGreaterThan(exactNextRunAt);
    expect(createdB.intent.nextRunAt).toBeGreaterThan(exactNextRunAt);
    expect(createdA.intent.nextRunAt).not.toBe(createdB.intent.nextRunAt);
  });

  test("rejects invalid cron expressions on create", async () => {
    const workspace = createWorkspace("cron-invalid");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-invalid",
      reason: "invalid cron",
      continuityMode: "inherit",
      cron: "* *",
    });
    scheduler.stop();

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error).toBe("invalid_cron");
    }
  });

  test("rejects invalid timeZone values on create", async () => {
    const workspace = createWorkspace("cron-invalid-timezone");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-invalid-timezone",
      reason: "invalid timezone",
      continuityMode: "inherit",
      cron: "*/5 * * * *",
      timeZone: "Not/A_Real_Timezone",
    });
    scheduler.stop();

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error).toBe("invalid_time_zone");
    }
  });

  test("rejects timeZone when cron is not provided", async () => {
    const workspace = createWorkspace("timezone-requires-cron");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-timezone-guard",
      reason: "timezone guard",
      continuityMode: "inherit",
      runAt: Date.now() + 120_000,
      timeZone: "Asia/Shanghai",
    });
    scheduler.stop();

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error).toBe("timeZone_requires_cron");
    }
  });

  test("defaults maxRuns to 10000 for cron intents", async () => {
    const workspace = createWorkspace("cron-default-max-runs");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-default-max-runs",
      reason: "default max runs",
      continuityMode: "inherit",
      cron: "*/15 * * * *",
    });
    scheduler.stop();

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.intent.maxRuns).toBe(10_000);
  });

  test("revives a converged intent when maxRuns is increased via update", async () => {
    const workspace = createWorkspace("revive-converged");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.minIntervalMs = 60_000;
      }),
    });

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const sessionId = "session-revive";
    const dueRunAt = nowMs - 1_000;

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-revive-1",
        parentSessionId: sessionId,
        reason: "revive test",
        continuityMode: "inherit",
        runAt: dueRunAt,
        nextRunAt: dueRunAt,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const fired: string[] = [];
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      executeIntent: async (intent) => {
        fired.push(intent.intentId);
      },
    });
    await scheduler.recover();
    expect(fired.length).toBe(1);

    const converged = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-revive-1");
    expect(converged?.status).toBe("converged");
    expect(converged?.nextRunAt).toBeUndefined();

    const updated = scheduler.updateIntent({
      parentSessionId: sessionId,
      intentId: "intent-revive-1",
      maxRuns: 5,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      scheduler.stop();
      return;
    }
    expect(updated.intent.status).toBe("active");
    expect(typeof updated.intent.nextRunAt).toBe("number");
    expect(updated.intent.maxRuns).toBe(5);

    scheduler.stop();
  });
});
