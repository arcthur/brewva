import { describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { createDaemonHarness, getSupervisorForTest } from "./gateway-control-plane.helpers.js";
import {
  RawEventFrame,
  closeRawSocket,
  connectRawAuthenticated,
  injectWorkerEvent,
  sendRawRequest,
  startDaemonHarness,
  waitForNoRawFrame,
  waitForRawFrame,
  withTimeout,
} from "./gateway-raw.helpers.js";

describe("gateway supervision and subscriptions", () => {
  test("routes session-scoped worker events only to subscribed connections", async () => {
    const harness = await startDaemonHarness([]);
    let wsA: WebSocket | null = null;
    let wsB: WebSocket | null = null;
    try {
      wsA = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });
      wsB = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const subscribeA = await sendRawRequest(wsA, "sessions.subscribe", {
        sessionId: "session-A",
      });
      const subscribeB = await sendRawRequest(wsB, "sessions.subscribe", {
        sessionId: "session-B",
      });
      expect(subscribeA.ok).toBe(true);
      expect(subscribeB.ok).toBe(true);

      const subscribedEventPromise = waitForRawFrame<RawEventFrame>(
        wsA,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.start") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-A";
        },
        2_000,
      );

      injectWorkerEvent(harness.daemon, "session.turn.start", {
        sessionId: "session-A",
        agentSessionId: "agent-A",
        turnId: "turn-A",
        ts: Date.now(),
      });

      const scopedEvent = await subscribedEventPromise;
      expect(scopedEvent.event).toBe("session.turn.start");

      await waitForNoRawFrame(
        wsB,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.start") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-A";
        },
        800,
      );
    } finally {
      if (wsA) {
        await closeRawSocket(wsA);
      }
      if (wsB) {
        await closeRawSocket(wsB);
      }
      await harness.dispose();
    }
  });

  test("cleans up scoped subscriptions on unsubscribe and socket close", async () => {
    const harness = await startDaemonHarness([]);
    let ws: WebSocket | null = null;
    try {
      ws = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const subscribed = await sendRawRequest(ws, "sessions.subscribe", {
        sessionId: "session-cleanup",
      });
      expect(subscribed.ok).toBe(true);

      const unsubscribed = await sendRawRequest(ws, "sessions.unsubscribe", {
        sessionId: "session-cleanup",
      });
      expect(unsubscribed.ok).toBe(true);

      injectWorkerEvent(harness.daemon, "session.turn.end", {
        sessionId: "session-cleanup",
        agentSessionId: "agent-cleanup",
        turnId: "turn-cleanup",
        assistantText: "done",
        toolOutputs: [],
        ts: Date.now(),
      });

      await waitForNoRawFrame(
        ws,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.end") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-cleanup";
        },
        800,
      );

      const resubscribed = await sendRawRequest(ws, "sessions.subscribe", {
        sessionId: "session-cleanup",
      });
      expect(resubscribed.ok).toBe(true);

      await closeRawSocket(ws);
      ws = null;

      await withTimeout(
        new Promise<void>((resolveCleanup, rejectCleanup) => {
          const startedAt = Date.now();
          const poll = (): void => {
            if (harness.daemon.testHooks.getSessionSubscriberIds("session-cleanup").length === 0) {
              resolveCleanup();
              return;
            }
            if (Date.now() - startedAt > 1_500) {
              rejectCleanup(new Error("session subscription cleanup timeout"));
              return;
            }
            setTimeout(poll, 25).unref?.();
          };
          poll();
        }),
        2_000,
        "subscription cleanup wait timeout",
      );
      expect(harness.daemon.testHooks.getSessionSubscriberIds("session-cleanup")).toHaveLength(0);
    } finally {
      if (ws) {
        await closeRawSocket(ws);
      }
      await harness.dispose();
    }
  });

  test("keeps identical seq values for all subscribers of the same session", async () => {
    const harness = await startDaemonHarness([]);
    let wsA: WebSocket | null = null;
    let wsB: WebSocket | null = null;
    try {
      wsA = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });
      wsB = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const [subscribeA, subscribeB] = await Promise.all([
        sendRawRequest(wsA, "sessions.subscribe", { sessionId: "session-shared" }),
        sendRawRequest(wsB, "sessions.subscribe", { sessionId: "session-shared" }),
      ]);
      expect(subscribeA.ok).toBe(true);
      expect(subscribeB.ok).toBe(true);

      const eventAPromise = waitForRawFrame<RawEventFrame>(
        wsA,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.chunk") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-shared";
        },
        2_000,
      );
      const eventBPromise = waitForRawFrame<RawEventFrame>(
        wsB,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.chunk") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-shared";
        },
        2_000,
      );

      injectWorkerEvent(harness.daemon, "session.turn.chunk", {
        sessionId: "session-shared",
        agentSessionId: "agent-shared",
        turnId: "turn-shared",
        chunk: {
          kind: "assistant_text_delta",
          delta: "hello",
        },
        ts: Date.now(),
      });

      const [resolvedA, resolvedB] = await Promise.all([eventAPromise, eventBPromise]);
      expect(typeof resolvedA.seq).toBe("number");
      expect(typeof resolvedB.seq).toBe("number");
      expect(resolvedA.seq).toBe(resolvedB.seq);
    } finally {
      if (wsA) {
        await closeRawSocket(wsA);
      }
      if (wsB) {
        await closeRawSocket(wsB);
      }
      await harness.dispose();
    }
  });

  test("keeps identical broadcast seq values across authenticated connections", async () => {
    const harness = await startDaemonHarness([]);
    let wsA: WebSocket | null = null;
    let wsB: WebSocket | null = null;
    try {
      wsA = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });
      wsB = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const [tickA, tickB] = await Promise.all([
        waitForRawFrame<{ type: "event"; event: "tick"; seq?: number }>(
          wsA,
          (frame: unknown): frame is { type: "event"; event: "tick"; seq?: number } => {
            if (!frame || typeof frame !== "object") {
              return false;
            }
            const row = frame as { type?: unknown; event?: unknown };
            return row.type === "event" && row.event === "tick";
          },
          4_000,
        ),
        waitForRawFrame<{ type: "event"; event: "tick"; seq?: number }>(
          wsB,
          (frame: unknown): frame is { type: "event"; event: "tick"; seq?: number } => {
            if (!frame || typeof frame !== "object") {
              return false;
            }
            const row = frame as { type?: unknown; event?: unknown };
            return row.type === "event" && row.event === "tick";
          },
          4_000,
        ),
      ]);

      expect(typeof tickA.seq).toBe("number");
      expect(typeof tickB.seq).toBe("number");
      expect(tickA.seq).toBe(tickB.seq);
    } finally {
      if (wsA) {
        await closeRawSocket(wsA);
      }
      if (wsB) {
        await closeRawSocket(wsB);
      }
      await harness.dispose();
    }
  });

  test("idle sweep closes only truly idle sessions", async () => {
    const harness = createDaemonHarness([], {
      sessionIdleTtlMs: 5_000,
      sessionIdleSweepIntervalMs: 1_000,
    });

    try {
      const supervisor = getSupervisorForTest(harness.daemon);
      const now = Date.now();
      supervisor.testHooks.resetWorkers();
      supervisor.testHooks.seedWorker({
        sessionId: "idle-target",
        pid: 10031,
        lastActivityAt: now - 8_000,
      });
      supervisor.testHooks.seedWorker({
        sessionId: "pending-busy",
        pid: 10032,
        lastActivityAt: now - 8_000,
        pendingCount: 1,
      });
      supervisor.testHooks.seedWorker({
        sessionId: "ready-busy",
        pid: 10033,
        lastActivityAt: now - 8_000,
        readyRequestId: "ready-1",
      });
      supervisor.testHooks.seedWorker({
        sessionId: "fresh",
        pid: 10034,
        lastActivityAt: now - 1_000,
      });

      const stopCalls: Array<{ sessionId: string; reason?: string; timeoutMs?: number }> = [];
      supervisor.stopSession = async (sessionId, reason, timeoutMs) => {
        stopCalls.push({ sessionId, reason, timeoutMs });
        return true;
      };

      await supervisor.testHooks.sweepIdleSessions();

      expect(stopCalls).toEqual([
        {
          sessionId: "idle-target",
          reason: "idle_timeout",
          timeoutMs: undefined,
        },
      ]);
    } finally {
      harness.dispose();
    }
  });

  test("continues idle sweep when stopping one idle session fails", async () => {
    const harness = createDaemonHarness([], {
      sessionIdleTtlMs: 5_000,
      sessionIdleSweepIntervalMs: 1_000,
    });

    try {
      const supervisor = getSupervisorForTest(harness.daemon);
      const now = Date.now();
      supervisor.testHooks.resetWorkers();
      supervisor.testHooks.seedWorker({
        sessionId: "idle-fail",
        pid: 10041,
        lastActivityAt: now - 9_000,
      });
      supervisor.testHooks.seedWorker({
        sessionId: "idle-next",
        pid: 10042,
        lastActivityAt: now - 9_500,
      });

      const stopCalls: string[] = [];
      supervisor.stopSession = async (sessionId) => {
        stopCalls.push(sessionId);
        if (sessionId === "idle-fail") {
          throw new Error("simulated stop failure");
        }
        return true;
      };

      await supervisor.testHooks.sweepIdleSessions();
      expect(stopCalls).toEqual(["idle-fail", "idle-next"]);
    } finally {
      harness.dispose();
    }
  });
});
