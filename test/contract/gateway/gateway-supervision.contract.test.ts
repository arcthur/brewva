import { describe, expect, test } from "bun:test";
import type { ContextPressureView, SessionWireFrame } from "@brewva/brewva-runtime";
import type WebSocket from "ws";
import {
  createDaemonHarness,
  createSessionBackendStub,
  getSupervisorForTest,
} from "./gateway-control-plane.helpers.js";
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
          if (row.type !== "event" || row.event !== "session.wire.frame") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown; type?: unknown } | undefined;
          return payload?.sessionId === "session-A" && payload?.type === "turn.input";
        },
        2_000,
      );

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-A",
        frame: {
          schema: "brewva.session-wire.v2",
          sessionId: "session-A",
          frameId: "live:turn-input",
          ts: Date.now(),
          source: "live",
          durability: "durable",
          sourceEventId: "evt-live-turn-input",
          sourceEventType: "turn_input_recorded",
          type: "turn.input",
          turnId: "turn-A",
          trigger: "user",
          promptText: "hello",
        },
      });

      const scopedEvent = await subscribedEventPromise;
      expect(scopedEvent.event).toBe("session.wire.frame");

      await waitForNoRawFrame(
        wsB,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.wire.frame") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown; type?: unknown } | undefined;
          return payload?.sessionId === "session-A" && payload?.type === "turn.input";
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

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        schema: "brewva.session-wire.v2",
        sessionId: "session-cleanup",
        frameId: "replay:turn-committed",
        ts: Date.now(),
        source: "live",
        durability: "durable",
        sourceEventId: "evt-cleanup-turn-committed",
        sourceEventType: "turn_render_committed",
        type: "turn.committed",
        turnId: "turn-cleanup",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "done",
        toolOutputs: [],
      });

      await waitForNoRawFrame(
        ws,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.wire.frame") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown; type?: unknown } | undefined;
          return payload?.sessionId === "session-cleanup" && payload?.type === "turn.committed";
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

  test("drops invalid v2 tool frames that are missing attemptId", async () => {
    const harness = await startDaemonHarness([]);
    let ws: WebSocket | null = null;
    try {
      ws = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const subscribed = await sendRawRequest(ws, "sessions.subscribe", {
        sessionId: "session-invalid-tool-frame",
      });
      expect(subscribed.ok).toBe(true);

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-invalid-tool-frame",
        frame: {
          schema: "brewva.session-wire.v2",
          sessionId: "session-invalid-tool-frame",
          frameId: "live:invalid-tool-started",
          ts: Date.now(),
          source: "live",
          durability: "cache",
          type: "tool.started",
          turnId: "turn-invalid",
          toolCallId: "tool-call-invalid",
          toolName: "exec",
        },
      });

      await waitForNoRawFrame(
        ws,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.wire.frame") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown; type?: unknown } | undefined;
          return (
            payload?.sessionId === "session-invalid-tool-frame" && payload?.type === "tool.started"
          );
        },
        800,
      );
    } finally {
      if (ws) {
        await closeRawSocket(ws);
      }
      await harness.dispose();
    }
  });

  test("replays durable frames before emitting the live session status snapshot", async () => {
    const frames: unknown[] = [];
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub({
        querySessionWire: async () => [
          {
            schema: "brewva.session-wire.v2",
            sessionId: "agent-session-replay",
            frameId: "replay:turn-input",
            ts: 1,
            source: "replay",
            durability: "durable",
            sourceEventId: "evt-1",
            sourceEventType: "turn_input_recorded",
            type: "turn.input",
            turnId: "turn-1",
            trigger: "user",
            promptText: "hello",
          },
          {
            schema: "brewva.session-wire.v2",
            sessionId: "agent-session-replay",
            frameId: "replay:turn-committed",
            ts: 2,
            source: "replay",
            durability: "durable",
            sourceEventId: "evt-2",
            sourceEventType: "turn_render_committed",
            type: "turn.committed",
            turnId: "turn-1",
            attemptId: "attempt-1",
            status: "completed",
            assistantText: "done",
            toolOutputs: [],
          },
        ],
        querySessionContextPressure: async () => ({
          tokens: 4200,
          limit: 8000,
          level: "elevated",
        }),
      }),
    });
    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-replay",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: () => undefined,
          terminate: () => undefined,
          send: (data: string) => {
            frames.push(JSON.parse(data));
          },
        },
      });
      const subscribed = await harness.daemon.testHooks.invokeMethod(
        "sessions.subscribe",
        { sessionId: "session-replay" },
        { connId: connection.connId },
      );
      expect(subscribed).toEqual({
        sessionId: "session-replay",
        subscribed: true,
      });

      const observedFrames = frames
        .filter((frame): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          return row.type === "event" && row.event === "session.wire.frame";
        })
        .map((frame) => frame.payload as Record<string, unknown>);

      expect(observedFrames.map((frame) => frame.type)).toEqual([
        "replay.begin",
        "turn.input",
        "turn.committed",
        "replay.complete",
        "session.status",
      ]);
      expect(observedFrames[4]).toMatchObject({
        type: "session.status",
        state: "idle",
        contextPressure: {
          tokens: 4200,
          limit: 8000,
          level: "elevated",
        },
      });
    } finally {
      harness.dispose();
    }
  });

  test("flushes replay-window live frames before any synthesized status snapshot", async () => {
    const frames: unknown[] = [];
    let resolveReplayQuery: ((frames: SessionWireFrame[]) => void) | undefined;
    const replayQuery = new Promise<SessionWireFrame[]>((resolveQuery) => {
      resolveReplayQuery = resolveQuery;
    });
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub({
        querySessionWire: async () => await replayQuery,
        querySessionContextPressure: async () => undefined,
      }),
    });

    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-live-before-status",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: () => undefined,
          terminate: () => undefined,
          send: (data: string) => {
            frames.push(JSON.parse(data));
          },
        },
      });

      const subscribePromise = harness.daemon.testHooks.invokeMethod(
        "sessions.subscribe",
        { sessionId: "session-live-before-status" },
        { connId: connection.connId },
      );

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-live-before-status",
        frame: {
          schema: "brewva.session-wire.v2",
          sessionId: "agent-session-live-before-status",
          frameId: "live:assistant-delta",
          ts: Date.now(),
          source: "live",
          durability: "cache",
          type: "assistant.delta",
          turnId: "turn-1",
          attemptId: "attempt-1",
          lane: "answer",
          delta: "hello",
        },
      });
      resolveReplayQuery?.([]);

      await subscribePromise;
      await withTimeout(
        new Promise<void>((resolveReady, rejectReady) => {
          const startedAt = Date.now();
          const poll = (): void => {
            const observed = frames
              .filter((frame): frame is RawEventFrame => {
                if (!frame || typeof frame !== "object") {
                  return false;
                }
                const row = frame as Partial<RawEventFrame>;
                return row.type === "event" && row.event === "session.wire.frame";
              })
              .map((frame) => frame.payload as SessionWireFrame);
            if (
              observed.some((frame) => frame.type === "assistant.delta") &&
              observed.some((frame) => frame.type === "session.status")
            ) {
              resolveReady();
              return;
            }
            if (Date.now() - startedAt > 1_500) {
              rejectReady(new Error("live replay-window status ordering timeout"));
              return;
            }
            setTimeout(poll, 10).unref?.();
          };
          poll();
        }),
        2_000,
        "replay-window status ordering wait timeout",
      );

      const observedFrames = frames
        .filter((frame): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          return row.type === "event" && row.event === "session.wire.frame";
        })
        .map((frame) => frame.payload as SessionWireFrame);

      const assistantDeltaIndex = observedFrames.findIndex(
        (frame) => frame.type === "assistant.delta",
      );
      const statusIndex = observedFrames.findIndex((frame) => frame.type === "session.status");
      expect(assistantDeltaIndex).toBeGreaterThanOrEqual(0);
      expect(statusIndex).toBeGreaterThan(assistantDeltaIndex);
      expect(observedFrames[statusIndex]).toMatchObject({
        type: "session.status",
        state: "running",
      });
      expect(
        observedFrames.some((frame) => frame.type === "session.status" && frame.state === "idle"),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  test("deduplicates durable live frames that overlap the replay query window", async () => {
    const frames: unknown[] = [];
    let resolveReplayQuery: ((frames: SessionWireFrame[]) => void) | undefined;
    const replayQuery = new Promise<SessionWireFrame[]>((resolveQuery) => {
      resolveReplayQuery = resolveQuery;
    });
    const replayCommittedFrame: SessionWireFrame = {
      schema: "brewva.session-wire.v2",
      sessionId: "agent-session-race",
      frameId: "evt-2:turn.committed",
      ts: 2,
      source: "replay",
      durability: "durable",
      sourceEventId: "evt-2",
      sourceEventType: "turn_render_committed",
      type: "turn.committed",
      turnId: "turn-1",
      attemptId: "attempt-1",
      status: "completed",
      assistantText: "done",
      toolOutputs: [],
    };
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub({
        querySessionWire: async () => await replayQuery,
      }),
    });

    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-race",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: () => undefined,
          terminate: () => undefined,
          send: (data: string) => {
            frames.push(JSON.parse(data));
          },
        },
      });

      const subscribePromise = harness.daemon.testHooks.invokeMethod(
        "sessions.subscribe",
        { sessionId: "session-race" },
        { connId: connection.connId },
      );

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-race",
        frame: {
          ...replayCommittedFrame,
          sessionId: "agent-session-race",
          source: "live",
        },
      });
      resolveReplayQuery?.([replayCommittedFrame]);

      await subscribePromise;

      const observedFrames = frames
        .filter((frame): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          return row.type === "event" && row.event === "session.wire.frame";
        })
        .map((frame) => frame.payload as SessionWireFrame);

      expect(
        observedFrames.filter(
          (frame) =>
            frame.type === "turn.committed" && frame.frameId === replayCommittedFrame.frameId,
        ),
      ).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  test("derives live session status frames with context pressure", async () => {
    let contextPressure:
      | {
          tokens: number;
          limit: number;
          level: "normal" | "elevated" | "critical";
        }
      | undefined;
    const frames: unknown[] = [];
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub({
        querySessionContextPressure: async () => contextPressure,
      }),
    });
    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-live-status",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: () => undefined,
          terminate: () => undefined,
          send: (data: string) => {
            frames.push(JSON.parse(data));
          },
        },
      });
      const subscribed = await harness.daemon.testHooks.invokeMethod(
        "sessions.subscribe",
        { sessionId: "session-live-status" },
        { connId: connection.connId },
      );
      expect(subscribed).toEqual({
        sessionId: "session-live-status",
        subscribed: true,
      });
      frames.length = 0;

      contextPressure = {
        tokens: 9700,
        limit: 10000,
        level: "critical",
      };
      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-live-status",
        frame: {
          schema: "brewva.session-wire.v2",
          sessionId: "agent-session-live-status",
          frameId: "live:assistant-delta",
          ts: Date.now(),
          source: "live",
          durability: "cache",
          type: "assistant.delta",
          turnId: "turn-1",
          attemptId: "attempt-1",
          lane: "answer",
          delta: "hello",
        },
      });

      await withTimeout(
        new Promise<void>((resolveReady, rejectReady) => {
          const startedAt = Date.now();
          const poll = (): void => {
            const wireFrames = frames.filter((frame) => {
              if (!frame || typeof frame !== "object") {
                return false;
              }
              const row = frame as Partial<RawEventFrame>;
              return row.type === "event" && row.event === "session.wire.frame";
            });
            if (wireFrames.length >= 2) {
              resolveReady();
              return;
            }
            if (Date.now() - startedAt > 1_500) {
              rejectReady(new Error("status frame not emitted"));
              return;
            }
            setTimeout(poll, 10).unref?.();
          };
          poll();
        }),
        2_000,
        "status frame wait timeout",
      );

      const wireFrames = frames
        .filter((frame): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          return row.type === "event" && row.event === "session.wire.frame";
        })
        .map((frame) => frame.payload as Record<string, unknown>);
      expect(wireFrames[0]).toMatchObject({
        type: "assistant.delta",
        sessionId: "session-live-status",
      });
      expect(wireFrames[1]).toMatchObject({
        type: "session.status",
        sessionId: "session-live-status",
        state: "running",
        contextPressure: {
          tokens: 9700,
          limit: 10000,
          level: "critical",
        },
      });
      expect((wireFrames[1] as { contextPressure?: unknown }).contextPressure).toEqual({
        tokens: 9700,
        limit: 10000,
        level: "critical",
      });
    } finally {
      harness.dispose();
    }
  });

  test("suppresses stale running status frames after a later terminal idle transition", async () => {
    let resolveRunningPressure: ((value: ContextPressureView | undefined) => void) | undefined;
    let contextPressureQueries = 0;
    const frames: unknown[] = [];
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub({
        querySessionContextPressure: async () => {
          contextPressureQueries += 1;
          if (contextPressureQueries === 1) {
            return undefined;
          }
          if (contextPressureQueries === 2) {
            return await new Promise<ContextPressureView | undefined>((resolveQuery) => {
              resolveRunningPressure = resolveQuery;
            });
          }
          return {
            tokens: 1200,
            limit: 8000,
            level: "normal",
          };
        },
      }),
    });

    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-status-monotonic",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: () => undefined,
          terminate: () => undefined,
          send: (data: string) => {
            frames.push(JSON.parse(data));
          },
        },
      });
      await harness.daemon.testHooks.invokeMethod(
        "sessions.subscribe",
        { sessionId: "session-status-monotonic" },
        { connId: connection.connId },
      );
      frames.length = 0;

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-status-monotonic",
        frame: {
          schema: "brewva.session-wire.v2",
          sessionId: "agent-session-status-monotonic",
          frameId: "live:assistant-delta",
          ts: Date.now(),
          source: "live",
          durability: "cache",
          type: "assistant.delta",
          turnId: "turn-1",
          attemptId: "attempt-1",
          lane: "answer",
          delta: "hello",
        },
      });
      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-status-monotonic",
        frame: {
          schema: "brewva.session-wire.v2",
          sessionId: "agent-session-status-monotonic",
          frameId: "live:turn-committed",
          ts: Date.now() + 1,
          source: "live",
          durability: "durable",
          sourceEventId: "evt-9",
          sourceEventType: "turn_render_committed",
          type: "turn.committed",
          turnId: "turn-1",
          attemptId: "attempt-1",
          status: "completed",
          assistantText: "done",
          toolOutputs: [],
        },
      });

      resolveRunningPressure?.({
        tokens: 7600,
        limit: 8000,
        level: "critical",
      });

      await new Promise<void>((resolveReady) => {
        const timer = setTimeout(resolveReady, 150);
        timer.unref?.();
      });

      const observedStatuses = frames
        .filter((frame): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          return row.type === "event" && row.event === "session.wire.frame";
        })
        .map((frame) => frame.payload as SessionWireFrame)
        .filter((frame) => frame.type === "session.status")
        .map((frame) => frame.state);
      expect(observedStatuses).not.toContain("running");
      expect(observedStatuses.every((state) => state === "idle")).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test("does not replay stale terminal status after reopening the same public session id", async () => {
    let workerOpen = false;
    const connectionAFrames: unknown[] = [];
    const connectionBFrames: unknown[] = [];
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub({
        openSession: async (input) => {
          workerOpen = true;
          return {
            sessionId: input.sessionId,
            created: true,
            workerPid: 4321,
          };
        },
        listWorkers: () =>
          workerOpen
            ? [
                {
                  sessionId: "session-reopen",
                  pid: 4321,
                  startedAt: 1,
                  lastHeartbeatAt: 1,
                  lastActivityAt: 1,
                  pendingRequests: 0,
                },
              ]
            : [],
        querySessionWire: async () => [],
      }),
    });

    try {
      const connectionA = harness.daemon.testHooks.registerConnection({
        connId: "conn-reopen-a",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: () => undefined,
          terminate: () => undefined,
          send: (data: string) => {
            connectionAFrames.push(JSON.parse(data));
          },
        },
      });

      const subscribedA = await harness.daemon.testHooks.invokeMethod(
        "sessions.subscribe",
        { sessionId: "session-reopen" },
        { connId: connectionA.connId },
      );
      expect(subscribedA).toEqual({
        sessionId: "session-reopen",
        subscribed: true,
      });
      connectionAFrames.length = 0;

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-reopen",
        frame: {
          schema: "brewva.session-wire.v2",
          sessionId: "session-reopen",
          frameId: "evt-reopen-session-closed",
          ts: Date.now(),
          source: "live",
          durability: "durable",
          sourceEventId: "evt-reopen-session-closed",
          sourceEventType: "session_shutdown",
          type: "session.closed",
          reason: "remote_close",
        },
      });

      await withTimeout(
        new Promise<void>((resolveReady, rejectReady) => {
          const startedAt = Date.now();
          const poll = (): void => {
            const observedFrames = connectionAFrames
              .filter((frame): frame is RawEventFrame => {
                if (!frame || typeof frame !== "object") {
                  return false;
                }
                const row = frame as Partial<RawEventFrame>;
                return row.type === "event" && row.event === "session.wire.frame";
              })
              .map((frame) => frame.payload as SessionWireFrame);
            if (
              observedFrames.some(
                (frame) => frame.type === "session.status" && frame.state === "closed",
              )
            ) {
              resolveReady();
              return;
            }
            if (Date.now() - startedAt > 1_500) {
              rejectReady(new Error("closed status frame not observed"));
              return;
            }
            setTimeout(poll, 10).unref?.();
          };
          poll();
        }),
        2_000,
        "closed status wait timeout",
      );

      const unsubscribedA = await harness.daemon.testHooks.invokeMethod(
        "sessions.unsubscribe",
        { sessionId: "session-reopen" },
        { connId: connectionA.connId },
      );
      expect(unsubscribedA).toEqual({
        sessionId: "session-reopen",
        unsubscribed: true,
      });

      const reopened = await harness.daemon.testHooks.invokeMethod(
        "sessions.open",
        { sessionId: "session-reopen" },
        { connId: connectionA.connId },
      );
      expect(reopened).toMatchObject({
        sessionId: "session-reopen",
        requestedSessionId: "session-reopen",
        created: true,
      });

      const connectionB = harness.daemon.testHooks.registerConnection({
        connId: "conn-reopen-b",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: () => undefined,
          terminate: () => undefined,
          send: (data: string) => {
            connectionBFrames.push(JSON.parse(data));
          },
        },
      });

      const subscribedB = await harness.daemon.testHooks.invokeMethod(
        "sessions.subscribe",
        { sessionId: "session-reopen" },
        { connId: connectionB.connId },
      );
      expect(subscribedB).toEqual({
        sessionId: "session-reopen",
        subscribed: true,
      });

      const observedFrames = connectionBFrames
        .filter((frame): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          return row.type === "event" && row.event === "session.wire.frame";
        })
        .map((frame) => frame.payload as SessionWireFrame);

      expect(
        observedFrames.some((frame) => frame.type === "session.status" && frame.state === "closed"),
      ).toBe(false);
      expect(observedFrames.at(-1)).toMatchObject({
        type: "session.status",
        state: "idle",
      });
    } finally {
      harness.dispose();
    }
  });

  test("deduplicates large replay overlaps and clears replay-only durable tracking after flush", async () => {
    const frames: unknown[] = [];
    let resolveReplayQuery: ((frames: SessionWireFrame[]) => void) | undefined;
    const replayQuery = new Promise<SessionWireFrame[]>((resolveQuery) => {
      resolveReplayQuery = resolveQuery;
    });
    const replayFrames = Array.from({ length: 320 }, (_, index) => ({
      schema: "brewva.session-wire.v2" as const,
      sessionId: "agent-session-large-replay",
      frameId: `evt-large-${index}:turn.input`,
      ts: index + 1,
      source: "replay" as const,
      durability: "durable" as const,
      sourceEventId: `evt-large-${index}`,
      sourceEventType: "turn_input_recorded" as const,
      type: "turn.input" as const,
      turnId: `turn-${index}`,
      trigger: "user" as const,
      promptText: `hello ${index}`,
    }));
    const harness = createDaemonHarness([], {
      sessionBackend: createSessionBackendStub({
        querySessionWire: async () => await replayQuery,
      }),
    });

    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-large-replay",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: () => undefined,
          terminate: () => undefined,
          send: (data: string) => {
            frames.push(JSON.parse(data));
          },
        },
      });

      const subscribePromise = harness.daemon.testHooks.invokeMethod(
        "sessions.subscribe",
        { sessionId: "session-large-replay" },
        { connId: connection.connId },
      );

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        sessionId: "session-large-replay",
        frame: {
          ...replayFrames[0],
          source: "live",
        },
      });
      resolveReplayQuery?.(replayFrames);

      await subscribePromise;

      const observedFrames = frames
        .filter((frame): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          return row.type === "event" && row.event === "session.wire.frame";
        })
        .map((frame) => frame.payload as SessionWireFrame);
      expect(
        observedFrames.filter((frame) => frame.frameId === replayFrames[0]?.frameId),
      ).toHaveLength(1);

      const snapshot = harness.daemon.testHooks.getConnectionSnapshot(connection.connId);
      expect(snapshot?.replaySessions).toEqual([]);
      expect(snapshot?.replayDedupFrameCountsBySession["session-large-replay"]).toBeUndefined();
    } finally {
      harness.dispose();
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
          if (row.type !== "event" || row.event !== "session.wire.frame") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown; type?: unknown } | undefined;
          return payload?.sessionId === "session-shared" && payload?.type === "assistant.delta";
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
          if (row.type !== "event" || row.event !== "session.wire.frame") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown; type?: unknown } | undefined;
          return payload?.sessionId === "session-shared" && payload?.type === "assistant.delta";
        },
        2_000,
      );

      injectWorkerEvent(harness.daemon, "session.wire.frame", {
        schema: "brewva.session-wire.v2",
        sessionId: "session-shared",
        frameId: "live:assistant-delta",
        ts: Date.now(),
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId: "turn-shared",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "hello",
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
