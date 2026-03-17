import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  BrewvaRuntime,
  SCHEDULE_EVENT_TYPE,
  SchedulerService,
  buildScheduleIntentCreatedEvent,
  parseScheduleIntentEvent,
} from "@brewva/brewva-runtime";
import {
  createSchedulerConfig,
  createWorkspace,
  schedulerRuntimePort,
} from "./scheduler-service.helpers.js";

describe("scheduler service recovery contract", () => {
  test("recovers a missed runAt intent and converges a one-shot intent", async () => {
    const workspace = createWorkspace("recover");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "scheduler-recover-session";
    const now = Date.now();

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-recover-1",
        parentSessionId: sessionId,
        reason: "recover test",
        continuityMode: "inherit",
        runAt: now - 1_000,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const fired: string[] = [];
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      executeIntent: async (intent) => {
        fired.push(intent.intentId);
      },
    });

    const recovered = await scheduler.recover();
    scheduler.stop();

    expect(recovered.rebuiltFromEvents).toBe(1);
    expect(recovered.catchUp.dueIntents).toBe(1);
    expect(recovered.catchUp.firedIntents).toBe(1);
    expect(recovered.catchUp.deferredIntents).toBe(0);
    expect(fired).toEqual(["intent-recover-1"]);

    const events = runtime.events.query(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_created");
    expect(kinds).toContain("intent_fired");
    expect(kinds).toContain("intent_converged");

    const projectionPath = scheduler.getProjectionPath();
    expect(existsSync(projectionPath)).toBe(true);
    const projectionContent = readFileSync(projectionPath, "utf8");
    expect(projectionContent).toContain('"brewva.schedule.projection.v1"');
  });

  test("defers overflow missed intents beyond the catch-up limit", async () => {
    const workspace = createWorkspace("recover-overflow");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.maxRecoveryCatchUps = 1;
        config.schedule.minIntervalMs = 60_000;
      }),
    });

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const sessionId = "scheduler-recover-overflow-session";
    const dueRunAt = nowMs - 10_000;

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-overflow-1",
        parentSessionId: sessionId,
        reason: "recover overflow 1",
        continuityMode: "inherit",
        runAt: dueRunAt,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });
    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-overflow-2",
        parentSessionId: sessionId,
        reason: "recover overflow 2",
        continuityMode: "inherit",
        runAt: dueRunAt + 1,
        maxRuns: 2,
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

    const recovered = await scheduler.recover();
    scheduler.stop();

    expect(fired).toEqual(["intent-overflow-1"]);
    expect(recovered.catchUp.dueIntents).toBe(2);
    expect(recovered.catchUp.firedIntents).toBe(1);
    expect(recovered.catchUp.deferredIntents).toBe(1);

    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-overflow-2");
    expect(state?.status).toBe("active");
    expect(state?.runCount).toBe(0);
    expect(state?.nextRunAt).toBe(nowMs + runtime.config.schedule.minIntervalMs);

    const deferredEvents = runtime.events.query(sessionId, { type: "schedule_recovery_deferred" });
    expect(deferredEvents.length).toBe(1);
    const deferredPayload = deferredEvents[0]?.payload;
    expect(deferredPayload?.intentId).toBe("intent-overflow-2");
    expect(deferredPayload?.deferredTo).toBe(nowMs + runtime.config.schedule.minIntervalMs);
  });

  test("round-robins catch-up across sessions and emits recovery summaries", async () => {
    const workspace = createWorkspace("recover-fairness");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.maxRecoveryCatchUps = 2;
        config.schedule.minIntervalMs = 60_000;
      }),
    });

    const nowMs = Date.UTC(2026, 0, 1, 1, 0, 0, 0);
    const dueRunAt = nowMs - 10_000;

    runtime.events.record({
      sessionId: "session-fair-a",
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-fair-a1",
        parentSessionId: "session-fair-a",
        reason: "fairness a1",
        continuityMode: "inherit",
        runAt: dueRunAt,
        maxRuns: 2,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });
    runtime.events.record({
      sessionId: "session-fair-a",
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-fair-a2",
        parentSessionId: "session-fair-a",
        reason: "fairness a2",
        continuityMode: "inherit",
        runAt: dueRunAt + 1,
        maxRuns: 2,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });
    runtime.events.record({
      sessionId: "session-fair-b",
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-fair-b1",
        parentSessionId: "session-fair-b",
        reason: "fairness b1",
        continuityMode: "inherit",
        runAt: dueRunAt + 2,
        maxRuns: 2,
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

    const recovered = await scheduler.recover();
    scheduler.stop();

    expect(fired).toEqual(["intent-fair-a1", "intent-fair-b1"]);
    expect(recovered.catchUp.dueIntents).toBe(3);
    expect(recovered.catchUp.firedIntents).toBe(2);
    expect(recovered.catchUp.deferredIntents).toBe(1);

    const catchUpSessionA = recovered.catchUp.sessions.find(
      (session) => session.parentSessionId === "session-fair-a",
    );
    const catchUpSessionB = recovered.catchUp.sessions.find(
      (session) => session.parentSessionId === "session-fair-b",
    );
    expect(catchUpSessionA).toEqual({
      parentSessionId: "session-fair-a",
      dueIntents: 2,
      firedIntents: 1,
      deferredIntents: 1,
    });
    expect(catchUpSessionB).toEqual({
      parentSessionId: "session-fair-b",
      dueIntents: 1,
      firedIntents: 1,
      deferredIntents: 0,
    });

    const summaryA = runtime.events.query("session-fair-a", { type: "schedule_recovery_summary" });
    const summaryB = runtime.events.query("session-fair-b", { type: "schedule_recovery_summary" });
    expect(summaryA.length).toBe(1);
    expect(summaryB.length).toBe(1);
    expect(summaryA[0]?.payload?.firedIntents).toBe(1);
    expect(summaryA[0]?.payload?.deferredIntents).toBe(1);
    expect(summaryB[0]?.payload?.firedIntents).toBe(1);
    expect(summaryB[0]?.payload?.deferredIntents).toBe(0);

    const deferredA = runtime.events.query("session-fair-a", {
      type: "schedule_recovery_deferred",
    });
    expect(deferredA.length).toBe(1);
    expect(deferredA[0]?.payload?.intentId).toBe("intent-fair-a2");
  });

  test("opens the circuit and cancels the intent after repeated executeIntent failures", async () => {
    const workspace = createWorkspace("circuit");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.maxConsecutiveErrors = 2;
        config.schedule.minIntervalMs = 10;
      }),
    });

    let nowMs = Date.now();
    const sessionId = "scheduler-circuit-session";

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-circuit-1",
        parentSessionId: sessionId,
        reason: "circuit test",
        continuityMode: "inherit",
        runAt: nowMs - 1_000,
        maxRuns: 5,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      executeIntent: async () => {
        throw new Error("boom");
      },
    });

    await scheduler.recover();
    nowMs += 1_000;
    await scheduler.recover();
    scheduler.stop();

    const events = runtime.events.query(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const parsed = events.map((event) => parseScheduleIntentEvent(event)).filter(Boolean);
    const cancelled = parsed.find((event) => event?.kind === "intent_cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled?.error?.startsWith("circuit_open:")).toBe(true);

    const snapshot = scheduler.snapshot();
    const state = snapshot.intents.find((intent) => intent.intentId === "intent-circuit-1");
    expect(state?.status).toBe("error");
  });

  test("records the error and schedules a retry when executeIntent fails below the threshold", async () => {
    const workspace = createWorkspace("execution-error-retry");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.maxConsecutiveErrors = 3;
        config.schedule.minIntervalMs = 10;
      }),
    });

    const nowMs = Date.now();
    const sessionId = "scheduler-error-retry-session";
    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-error-retry-1",
        parentSessionId: sessionId,
        reason: "retry before circuit",
        continuityMode: "inherit",
        runAt: nowMs - 1_000,
        maxRuns: 5,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      executeIntent: async () => {
        throw new Error("boom-once");
      },
    });

    await scheduler.recover();
    scheduler.stop();

    const events = runtime.events.query(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const parsed = events.map((event) => parseScheduleIntentEvent(event)).filter(Boolean);
    const fired = parsed.find((event) => event?.kind === "intent_fired");
    const cancelled = parsed.find((event) => event?.kind === "intent_cancelled");
    expect(fired).toBeDefined();
    expect(fired?.error).toBe("boom-once");
    expect(cancelled).toBeUndefined();

    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-error-retry-1");
    expect(state?.status).toBe("active");
    expect(state?.consecutiveErrors).toBe(1);
    expect(state?.lastError).toBe("boom-once");
    expect(state?.nextRunAt).toBe(nowMs + runtime.config.schedule.minIntervalMs);
  });

  test("catches up a missed cron run and schedules the next slot", async () => {
    const workspace = createWorkspace("cron-recover");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.minIntervalMs = 60_000;
      }),
    });

    let nowMs = Date.UTC(2026, 0, 1, 0, 1, 30, 0);
    const executed: number[] = [];
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      executeIntent: async () => {
        executed.push(nowMs);
      },
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-recover",
      reason: "cron recover",
      continuityMode: "inherit",
      cron: "*/2 * * * *",
      maxRuns: 3,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const firstNextRunAt = created.intent.nextRunAt;
    expect(typeof firstNextRunAt).toBe("number");
    if (typeof firstNextRunAt === "number") {
      nowMs = firstNextRunAt + 30_000;
    }

    await scheduler.recover();
    scheduler.stop();

    expect(executed.length).toBe(1);
    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === created.intent.intentId);
    expect(state?.status).toBe("active");
    expect(state?.runCount).toBe(1);
    expect(typeof state?.nextRunAt).toBe("number");
    if (typeof state?.nextRunAt === "number" && typeof firstNextRunAt === "number") {
      expect(state.nextRunAt).toBeGreaterThan(firstNextRunAt);
      expect(new Date(state.nextRunAt).getMinutes() % 2).toBe(0);
    }

    const events = runtime.events.query("session-cron-recover", { type: SCHEDULE_EVENT_TYPE });
    const firedCount = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind) => kind === "intent_fired").length;
    expect(firedCount).toBe(1);
  });

  test("subscribes to runtime events from external intent creation", async () => {
    const workspace = createWorkspace("subscribe-events");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createSchedulerConfig((config) => {
        config.schedule.minIntervalMs = 60_000;
      }),
    });

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const daemonScheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      executeIntent: async () => {},
    });
    await daemonScheduler.recover();

    const externalScheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      enableExecution: false,
    });
    await externalScheduler.recover();

    const created = externalScheduler.createIntent({
      parentSessionId: "session-external",
      reason: "created externally",
      continuityMode: "inherit",
      runAt: nowMs + 120_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      daemonScheduler.stop();
      externalScheduler.stop();
      return;
    }

    const daemonIntent = daemonScheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === created.intent.intentId);
    expect(daemonIntent).toBeDefined();
    expect(daemonIntent?.status).toBe("active");
    expect(daemonIntent?.reason).toBe("created externally");

    daemonScheduler.stop();
    externalScheduler.stop();
  });
});
