import { describe, expect, test } from "bun:test";
import { SessionBackendCapacityError, SessionBackendStateError } from "@brewva/brewva-gateway";
import {
  BrewvaRuntime,
  SCHEDULE_EVENT_TYPE,
  buildScheduleIntentCreatedEvent,
} from "@brewva/brewva-runtime";
import {
  ReloadPayload,
  SessionsClosePayload,
  createConnectionState,
  createDaemonHarness,
  createSessionBackendStub,
  getHandleMethod,
  sleep,
  writeHeartbeatPolicy,
} from "./gateway-control-plane.helpers.js";

describe("gateway daemon control-plane methods", () => {
  test("sessions.open forwards agentId to backend", async () => {
    let captured:
      | {
          sessionId: string;
          cwd?: string;
          configPath?: string;
          model?: string;
          agentId?: string;
          managedToolMode?: "runtime_plugin" | "direct";
        }
      | undefined;
    const backend = createSessionBackendStub({
      openSession: async (input) => {
        captured = input;
        return {
          sessionId: input.sessionId,
          created: true,
          workerPid: 4321,
          agentSessionId: "agent-open",
        };
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });

    try {
      const handleMethod = getHandleMethod(harness.daemon);
      const payload = (await handleMethod("sessions.open", {
        sessionId: "session-open",
        cwd: harness.root,
        configPath: ".brewva/brewva.json",
        model: "openai/gpt-5",
        agentId: "code-reviewer",
        managedToolMode: "direct",
      })) as {
        sessionId: string;
        created: boolean;
        workerPid: number;
        agentSessionId?: string;
        requestedSessionId: string;
      };

      expect(captured).toEqual({
        sessionId: "session-open",
        cwd: harness.root,
        configPath: ".brewva/brewva.json",
        model: "openai/gpt-5",
        agentId: "code-reviewer",
        managedToolMode: "direct",
      });
      expect(payload).toEqual({
        sessionId: "session-open",
        created: true,
        workerPid: 4321,
        agentSessionId: "agent-open",
        requestedSessionId: "session-open",
      });
    } finally {
      harness.dispose();
    }
  });

  test("heartbeat fire sends the explicit heartbeat prompt without extra trigger metadata", async () => {
    let captured:
      | {
          sessionId: string;
          prompt: string;
          options?: {
            waitForCompletion?: boolean;
            source?: "gateway" | "heartbeat";
            trigger?: unknown;
          };
        }
      | undefined;
    const backend = createSessionBackendStub({
      openSession: async () => ({
        sessionId: "heartbeat:nightly-release",
        created: true,
        workerPid: 4321,
      }),
      sendPrompt: async (sessionId, prompt, options) => {
        captured = {
          sessionId,
          prompt,
          options: options as {
            waitForCompletion?: boolean;
            source?: "gateway" | "heartbeat";
            trigger?: unknown;
          },
        };
        return {
          sessionId,
          turnId: "turn-heartbeat",
          accepted: true,
          output: {
            assistantText: "done",
            toolOutputs: [],
          },
        };
      },
    });
    const harness = createDaemonHarness(
      [
        {
          id: "nightly-release",
          intervalMinutes: 15,
          prompt: [
            "Check project status.",
            "Review ship posture.",
            "ship posture",
            "backlog risk",
          ].join("\n"),
        },
      ],
      { sessionBackend: backend },
    );

    try {
      await harness.daemon.testHooks.fireHeartbeat({
        id: "nightly-release",
        intervalMinutes: 15,
        prompt: [
          "Check project status.",
          "Review ship posture.",
          "ship posture",
          "backlog risk",
        ].join("\n"),
      });

      expect(captured?.options?.source).toBe("heartbeat");
      expect(captured?.options?.trigger).toBeUndefined();
      expect(captured?.prompt).toBe(
        ["Check project status.", "Review ship posture.", "ship posture", "backlog risk"].join(
          "\n",
        ),
      );
    } finally {
      harness.dispose();
    }
  });

  test("sessions.close forwards remote_close reason and supports false return", async () => {
    const calls: Array<{ sessionId: string; reason?: string; timeoutMs?: number }> = [];
    const backend = createSessionBackendStub({
      stopSession: async (sessionId, reason, timeoutMs) => {
        calls.push({ sessionId, reason, timeoutMs });
        return false;
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });

    try {
      const handleMethod = getHandleMethod(harness.daemon);
      const payload = (await handleMethod("sessions.close", {
        sessionId: "session-42",
      })) as SessionsClosePayload;

      expect(payload).toEqual({
        sessionId: "session-42",
        closed: false,
      });
      expect(calls).toEqual([
        {
          sessionId: "session-42",
          reason: "remote_close",
          timeoutMs: undefined,
        },
      ]);
    } finally {
      harness.dispose();
    }
  });

  test("maps backend capacity errors to gateway bad_state with retry hint", async () => {
    const backend = createSessionBackendStub({
      openSession: async () => {
        throw new SessionBackendCapacityError("worker_limit", "session worker limit reached: 1", {
          maxWorkers: 1,
          currentWorkers: 1,
          queueDepth: 0,
          maxQueueDepth: 64,
        });
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });

    try {
      const handleMethod = getHandleMethod(harness.daemon);
      let openError: unknown;
      try {
        await handleMethod("sessions.open", {
          sessionId: "s-overflow",
        });
      } catch (error) {
        openError = error;
      }
      expect(openError).toMatchObject({
        code: "bad_state",
        retryable: true,
      });
    } finally {
      harness.dispose();
    }
  });

  test("sessions.send streams by default and auto-subscribes caller session scope", async () => {
    const calls: Array<{ sessionId: string; waitForCompletion?: boolean }> = [];
    const backend = createSessionBackendStub({
      sendPrompt: async (sessionId, _prompt, options) => {
        calls.push({
          sessionId,
          waitForCompletion: options?.waitForCompletion,
        });
        return {
          sessionId,
          agentSessionId: "agent-stream",
          turnId: "turn-stream",
          accepted: true,
        };
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });

    try {
      const handleMethod = getHandleMethod(harness.daemon);
      const state = createConnectionState("conn-send-stream");
      harness.daemon.testHooks.registerConnection(state);
      const payload = (await handleMethod(
        "sessions.send",
        {
          sessionId: "session-stream",
          prompt: "hello",
        },
        state,
      )) as {
        sessionId: string;
        agentSessionId?: string;
        turnId: string;
        accepted: boolean;
      };

      expect(calls).toEqual([
        {
          sessionId: "session-stream",
          waitForCompletion: false,
        },
      ]);
      expect(payload).toEqual({
        sessionId: "session-stream",
        agentSessionId: "agent-stream",
        turnId: "turn-stream",
        accepted: true,
      });
      expect(harness.daemon.testHooks.getConnectionSnapshot("conn-send-stream")).toMatchObject({
        subscribedSessions: ["session-stream"],
      });
      expect(harness.daemon.testHooks.getSessionSubscriberIds("session-stream")).toContain(
        "conn-send-stream",
      );
    } finally {
      harness.dispose();
    }
  });

  test("maps backend session state errors to gateway bad_state", async () => {
    const backend = createSessionBackendStub({
      sendPrompt: async () => {
        throw new SessionBackendStateError(
          "session_busy",
          "session is busy with active turn: turn-123",
        );
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });

    try {
      const handleMethod = getHandleMethod(harness.daemon);
      let sendError: unknown;
      try {
        await handleMethod(
          "sessions.send",
          {
            sessionId: "session-busy",
            prompt: "hello",
          },
          createConnectionState("conn-send-busy"),
        );
      } catch (error) {
        sendError = error;
      }
      expect(sendError).toMatchObject({
        code: "bad_state",
        retryable: false,
        details: {
          kind: "session_busy",
        },
      });
    } finally {
      harness.dispose();
    }
  });

  test("heartbeat.reload cleans only default orphaned sessions and keeps shared or explicit sessions", async () => {
    const stopCalls: Array<{ sessionId: string; reason?: string; timeoutMs?: number }> = [];
    const backend = createSessionBackendStub({
      stopSession: async (sessionId, reason, timeoutMs) => {
        stopCalls.push({ sessionId, reason, timeoutMs });
        return sessionId !== "heartbeat:stop-false";
      },
    });
    const harness = createDaemonHarness(
      [
        {
          id: "default-removed",
          intervalMinutes: 5,
          prompt: "old-a",
        },
        {
          id: "explicit-removed",
          intervalMinutes: 5,
          prompt: "old-b",
          sessionId: "shared-session",
        },
        {
          id: "shared-keeper",
          intervalMinutes: 5,
          prompt: "old-c",
          sessionId: "shared-session",
        },
        {
          id: "session-changed",
          intervalMinutes: 5,
          prompt: "old-d",
        },
        {
          id: "stop-false",
          intervalMinutes: 5,
          prompt: "old-e",
        },
      ],
      { sessionBackend: backend },
    );

    try {
      writeHeartbeatPolicy(harness.policyPath, [
        {
          id: "shared-keeper",
          intervalMinutes: 5,
          prompt: "new-c",
          sessionId: "shared-session",
        },
        {
          id: "session-changed",
          intervalMinutes: 5,
          prompt: "new-d",
          sessionId: "explicit-new-session",
        },
      ]);

      const handleMethod = getHandleMethod(harness.daemon);
      const payload = (await handleMethod("heartbeat.reload", {})) as ReloadPayload;

      expect(payload.rules).toBe(2);
      expect(payload.removedRules).toBe(3);
      expect(payload.closedSessions).toBe(2);
      expect(payload.removedRuleIds).toEqual(["default-removed", "explicit-removed", "stop-false"]);
      expect(payload.closedSessionIds).toEqual([
        "heartbeat:default-removed",
        "heartbeat:session-changed",
      ]);
      expect(stopCalls).toEqual([
        {
          sessionId: "heartbeat:default-removed",
          reason: "heartbeat_rule_removed",
          timeoutMs: undefined,
        },
        {
          sessionId: "heartbeat:session-changed",
          reason: "heartbeat_rule_removed",
          timeoutMs: undefined,
        },
        {
          sessionId: "heartbeat:stop-false",
          reason: "heartbeat_rule_removed",
          timeoutMs: undefined,
        },
      ]);
      expect(stopCalls.map((call) => call.sessionId)).not.toContain("shared-session");
    } finally {
      harness.dispose();
    }
  });

  test("heartbeat.reload does not close removed default sessions still referenced by active rules", async () => {
    const stopCalls: string[] = [];
    const backend = createSessionBackendStub({
      stopSession: async (sessionId) => {
        stopCalls.push(sessionId);
        return true;
      },
    });
    const harness = createDaemonHarness(
      [
        {
          id: "legacy",
          intervalMinutes: 5,
          prompt: "old",
        },
      ],
      { sessionBackend: backend },
    );

    try {
      writeHeartbeatPolicy(harness.policyPath, [
        {
          id: "consumer",
          intervalMinutes: 5,
          prompt: "new",
          sessionId: "heartbeat:legacy",
        },
      ]);

      const handleMethod = getHandleMethod(harness.daemon);
      const payload = (await handleMethod("heartbeat.reload", {})) as ReloadPayload;

      expect(payload.rules).toBe(1);
      expect(payload.removedRuleIds).toEqual(["legacy"]);
      expect(payload.closedSessionIds).toEqual([]);
      expect(stopCalls).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test("scheduler.pause and scheduler.resume are idempotent and update deep status", async () => {
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub(),
      scheduleEnabled: true,
    });

    try {
      const handleMethod = getHandleMethod(harness.daemon);

      const firstPause = (await handleMethod("scheduler.pause", {
        reason: "incident_mitigation",
      })) as {
        paused: boolean;
        changed: boolean;
        available: boolean;
        pausedAt: number | null;
        reason: string | null;
      };
      expect(firstPause.available).toBe(true);
      expect(firstPause.paused).toBe(true);
      expect(firstPause.changed).toBe(true);
      expect(firstPause.reason).toBe("incident_mitigation");
      expect(typeof firstPause.pausedAt).toBe("number");

      const secondPause = (await handleMethod("scheduler.pause", {
        reason: "ignored_on_idempotent_pause",
      })) as {
        available: boolean;
        paused: boolean;
        changed: boolean;
        pausedAt: number | null;
        reason: string | null;
      };
      expect(secondPause).toMatchObject({
        available: true,
        paused: true,
        changed: false,
        reason: "incident_mitigation",
      });
      expect(typeof secondPause.pausedAt).toBe("number");

      const deepWhilePaused = (await handleMethod("status.deep", {})) as {
        scheduler: {
          available: boolean;
          paused: boolean;
          reason?: string;
        };
      };
      expect(deepWhilePaused.scheduler).toMatchObject({
        available: true,
        paused: true,
        reason: "incident_mitigation",
      });

      const resumed = (await handleMethod("scheduler.resume", {})) as {
        paused: boolean;
        changed: boolean;
        available: boolean;
        previousPausedAt: number | null;
        previousReason: string | null;
      };
      expect(resumed.available).toBe(true);
      expect(resumed.paused).toBe(false);
      expect(resumed.changed).toBe(true);
      expect(typeof resumed.previousPausedAt).toBe("number");
      expect(resumed.previousReason).toBe("incident_mitigation");

      const deepAfterResume = (await handleMethod("status.deep", {})) as {
        scheduler: {
          available: boolean;
          paused: boolean;
          reason?: string;
        };
      };
      expect(deepAfterResume.scheduler).toMatchObject({
        available: true,
        paused: false,
      });
      expect(deepAfterResume.scheduler.reason).toBeUndefined();
    } finally {
      harness.dispose();
    }
  });

  test("scheduler.resume re-arms timers without calling recover", async () => {
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub(),
      scheduleEnabled: true,
    });

    try {
      const handleMethod = getHandleMethod(harness.daemon);
      await handleMethod("scheduler.pause", {
        reason: "resume_sync_test",
      });

      const daemonWithScheduler = harness.daemon as unknown as {
        scheduler: { recover(): Promise<unknown>; syncExecutionState(): void } | null;
      };
      const scheduler = daemonWithScheduler.scheduler;
      expect(scheduler).not.toBeNull();
      if (!scheduler) return;

      let recoverCalls = 0;
      const recover = scheduler.recover.bind(scheduler);
      scheduler.recover = async () => {
        recoverCalls += 1;
        return await recover();
      };

      let syncCalls = 0;
      const sync = scheduler.syncExecutionState.bind(scheduler);
      scheduler.syncExecutionState = () => {
        syncCalls += 1;
        return sync();
      };

      const resumed = (await handleMethod("scheduler.resume", {})) as {
        paused: boolean;
        changed: boolean;
      };
      expect(resumed.paused).toBe(false);
      expect(resumed.changed).toBe(true);
      expect(recoverCalls).toBe(0);
      expect(syncCalls).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  test("gateway daemon recovers and executes due schedule intents on start", async () => {
    const prompts: Array<{
      sessionId: string;
      source?: "gateway" | "heartbeat" | "schedule";
      waitForCompletion?: boolean;
    }> = [];
    const backend = createSessionBackendStub({
      openSession: async (input) => ({
        sessionId: input.sessionId,
        created: true,
        workerPid: 4321,
        agentSessionId: `${input.sessionId}-agent`,
      }),
      sendPrompt: async (sessionId, _prompt, options) => {
        prompts.push({
          sessionId,
          source: options?.source,
          waitForCompletion: options?.waitForCompletion,
        });
        return {
          sessionId,
          agentSessionId: `${sessionId}-agent`,
          turnId: "turn-schedule-start",
          accepted: true,
        };
      },
    });
    const harness = createDaemonHarness([], {
      sessionBackend: backend,
      scheduleEnabled: true,
    });

    try {
      const runtime = new BrewvaRuntime({ cwd: harness.root });
      const nowMs = Date.now();
      runtime.events.record({
        sessionId: "parent-session",
        type: SCHEDULE_EVENT_TYPE,
        payload: buildScheduleIntentCreatedEvent({
          intentId: "intent-gateway-start-recover-1",
          parentSessionId: "parent-session",
          reason: "recover on gateway start",
          continuityMode: "inherit",
          runAt: nowMs - 1_000,
          nextRunAt: nowMs - 1_000,
          maxRuns: 1,
        }) as unknown as Record<string, unknown>,
        skipTapeCheckpoint: true,
      });

      await harness.daemon.start();

      for (let attempt = 0; attempt < 20 && prompts.length === 0; attempt += 1) {
        await sleep(50);
      }

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        source: "schedule",
        waitForCompletion: true,
      });
      expect(prompts[0]?.sessionId).toContain("schedule:intent-gateway-start-recover-1:1");
    } finally {
      await harness.daemon.stop("test_cleanup").catch(() => undefined);
      await harness.daemon.waitForStop().catch(() => undefined);
      harness.dispose();
    }
  });
});
