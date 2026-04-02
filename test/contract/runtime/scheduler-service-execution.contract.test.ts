import { describe, expect, test } from "bun:test";
import {
  BrewvaRuntime,
  SCHEDULE_EVENT_TYPE,
  SchedulerService,
  type SchedulerRuntimePort,
  buildScheduleIntentCreatedEvent,
  parseScheduleIntentEvent,
} from "@brewva/brewva-runtime";
import { createWorkspace, schedulerRuntimePort } from "./scheduler-service.helpers.js";

describe("scheduler service execution contract", () => {
  test("operates through SchedulerRuntimePort without direct BrewvaRuntime coupling", async () => {
    const workspace = createWorkspace("runtime-port");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "scheduler-runtime-port-session";
    const now = Date.now();

    const runtimePort: SchedulerRuntimePort = {
      workspaceRoot: runtime.workspaceRoot,
      scheduleConfig: runtime.config.schedule,
      listSessionIds: () => runtime.events.listSessionIds(),
      listEvents: (targetSessionId, query) => runtime.events.list(targetSessionId, query),
      recordEvent: (input) => runtime.events.record(input),
      subscribeEvents: (listener) => runtime.events.subscribe(listener),
      getTruthState: (targetSessionId) => runtime.truth.getState(targetSessionId),
      getTaskState: (targetSessionId) => runtime.task.getState(targetSessionId),
    };

    const scheduler = new SchedulerService({
      runtime: runtimePort,
      enableExecution: false,
    });

    const recovered = await scheduler.recover();
    expect(recovered.rebuiltFromEvents).toBe(0);

    const created = scheduler.createIntent({
      parentSessionId: sessionId,
      reason: "runtime-port create",
      continuityMode: "inherit",
      runAt: now + 5_000,
    });
    expect(created.ok).toBe(true);

    const intents = scheduler.listIntents({ parentSessionId: sessionId });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.parentSessionId).toBe(sessionId);

    const scheduleEvents = runtime.events.query(sessionId, { type: SCHEDULE_EVENT_TYPE });
    expect(scheduleEvents.length).toBeGreaterThan(0);

    scheduler.stop();
  });

  test("keeps execution disabled when no executor callback is provided", async () => {
    const workspace = createWorkspace("no-executor");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const now = Date.now();
    const sessionId = "scheduler-no-executor-session";

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-no-executor-1",
        parentSessionId: sessionId,
        reason: "no executor",
        continuityMode: "inherit",
        runAt: now - 1_000,
        nextRunAt: now - 1_000,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({ runtime: schedulerRuntimePort(runtime) });
    await scheduler.recover();
    const stats = scheduler.getStats();
    scheduler.stop();

    expect(stats.executionEnabled).toBe(false);
    const events = runtime.events.query(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toEqual(["intent_created"]);
  });

  test("rejects duplicate intentId on create", async () => {
    const workspace = createWorkspace("duplicate-id");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      enableExecution: false,
    });
    await scheduler.recover();

    const runAt = Date.now() + 120_000;
    const first = scheduler.createIntent({
      parentSessionId: "session-dup",
      reason: "first",
      continuityMode: "inherit",
      runAt,
      intentId: "intent-fixed-id",
    });
    expect(first.ok).toBe(true);

    const second = scheduler.createIntent({
      parentSessionId: "session-dup",
      reason: "second",
      continuityMode: "inherit",
      runAt: runAt + 1_000,
      intentId: "intent-fixed-id",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe("intent_id_already_exists");
    }

    scheduler.stop();
  });

  test("converges by structured predicate for truth_resolved", async () => {
    const workspace = createWorkspace("predicate-truth");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "scheduler-predicate-session";
    const now = Date.now();

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-predicate-1",
        parentSessionId: sessionId,
        reason: "wait for ci_green",
        continuityMode: "inherit",
        runAt: now - 1_000,
        nextRunAt: now - 1_000,
        maxRuns: 5,
        convergenceCondition: {
          kind: "truth_resolved",
          factId: "ci_green",
        },
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      executeIntent: async (intent) => {
        const evaluationSessionId = `${intent.parentSessionId}-child`;
        runtime.truth.upsertFact(evaluationSessionId, {
          id: "ci_green",
          kind: "ci_pipeline",
          severity: "info",
          summary: "CI pipeline passed",
          status: "resolved",
        });
        return { evaluationSessionId };
      },
    });

    await scheduler.recover();
    scheduler.stop();

    const events = runtime.events.query(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_fired");
    expect(kinds).toContain("intent_converged");
    const fired = events
      .map(parseScheduleIntentEvent)
      .find((event) => event?.kind === "intent_fired");
    expect(fired?.childSessionId).toBe(`${sessionId}-child`);

    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-predicate-1");
    expect(state?.status).toBe("converged");
    expect(state?.runCount).toBe(1);
    expect(state?.lastEvaluationSessionId).toBe(`${sessionId}-child`);
  });

  test("skips catch-up while execution is paused and resumes via syncExecutionState", async () => {
    const workspace = createWorkspace("pause-resume-sync");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "scheduler-pause-resume-session";
    let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

    runtime.events.record({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-pause-resume-1",
        parentSessionId: sessionId,
        reason: "paused recover",
        continuityMode: "inherit",
        runAt: nowMs - 1_000,
        nextRunAt: nowMs - 1_000,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const fired: string[] = [];
    const scheduledCallbacks: Array<() => void> = [];
    let resolveExecution: (() => void) | undefined;
    const executed = new Promise<void>((resolve) => {
      resolveExecution = resolve;
    });
    let paused = true;
    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      shouldExecute: () => !paused,
      setTimer: (callback) => {
        scheduledCallbacks.push(callback);
        return callback;
      },
      clearTimer: () => undefined,
      executeIntent: async (intent) => {
        fired.push(intent.intentId);
        resolveExecution?.();
      },
    });

    const pausedRecover = await scheduler.recover();
    expect(pausedRecover.catchUp.dueIntents).toBe(0);
    expect(pausedRecover.catchUp.firedIntents).toBe(0);
    expect(fired).toEqual([]);
    expect(scheduledCallbacks).toHaveLength(0);

    paused = false;
    scheduler.syncExecutionState();
    expect(scheduledCallbacks).toHaveLength(1);
    nowMs += 1_000;
    scheduledCallbacks[0]?.();
    await executed;
    scheduler.stop();

    expect(fired).toEqual(["intent-pause-resume-1"]);
  });

  test("syncExecutionState clears armed timers when paused", async () => {
    const workspace = createWorkspace("sync-execution-state");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    let paused = false;
    const scheduledCallbacks: Array<() => void> = [];
    let clearCount = 0;

    const scheduler = new SchedulerService({
      runtime: schedulerRuntimePort(runtime),
      now: () => nowMs,
      enableExecution: true,
      shouldExecute: () => !paused,
      setTimer: (callback) => {
        scheduledCallbacks.push(callback);
        return callback;
      },
      clearTimer: () => {
        clearCount += 1;
      },
      executeIntent: async () => undefined,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      intentId: "intent-sync-execution-state-1",
      parentSessionId: "session-sync-execution-state",
      reason: "future timer",
      continuityMode: "inherit",
      runAt: nowMs + 120_000,
      maxRuns: 1,
    });
    expect(created.ok).toBe(true);
    expect(scheduler.getStats().timersArmed).toBe(1);

    paused = true;
    scheduler.syncExecutionState();
    scheduler.stop();

    expect(clearCount).toBeGreaterThan(0);
    expect(scheduler.getStats().timersArmed).toBe(0);
    expect(scheduledCallbacks.length).toBeGreaterThan(0);
  });
});
