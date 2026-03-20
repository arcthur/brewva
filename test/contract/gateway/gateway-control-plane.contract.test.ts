import { describe, expect, test } from "bun:test";
import { SessionBackendCapacityError, SessionBackendStateError } from "@brewva/brewva-gateway";
import {
  ReloadPayload,
  SessionsClosePayload,
  createConnectionState,
  createDaemonHarness,
  createSessionBackendStub,
  getHandleMethod,
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
          enableExtensions?: boolean;
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
        enableExtensions: false,
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
        enableExtensions: false,
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
            "Review release readiness.",
            "release readiness",
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
          "Review release readiness.",
          "release readiness",
          "backlog risk",
        ].join("\n"),
      });

      expect(captured?.options?.source).toBe("heartbeat");
      expect(captured?.options?.trigger).toBeUndefined();
      expect(captured?.prompt).toBe(
        [
          "Check project status.",
          "Review release readiness.",
          "release readiness",
          "backlog risk",
        ].join("\n"),
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
      expect(stopCalls.some((call) => call.sessionId === "shared-session")).toBe(false);
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
});
