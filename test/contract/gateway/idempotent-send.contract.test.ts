import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { SessionBackendStateError } from "@brewva/brewva-gateway";
import { createDaemonHarness, createSessionBackendStub } from "./gateway-control-plane.helpers.js";

// Cases here run real subprocesses, which can exceed bun's 5s default test timeout
// under machine load (bare `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

const SILENT_SOCKET = {
  readyState: 1,
  OPEN: 1,
  CONNECTING: 0,
  close: () => undefined,
  terminate: () => undefined,
  send: () => undefined,
};

describe("gateway contract: idempotent prompt admission", () => {
  test("a retry of sessions.send with the same turn id admits the turn only once", async () => {
    let sendCount = 0;
    const backend = createSessionBackendStub({
      sendPrompt: async (sessionId) => {
        sendCount += 1;
        return { sessionId, agentSessionId: "agent-9", turnId: "turn-42", accepted: true };
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });
    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-idem",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: SILENT_SOCKET,
      });
      const params = { sessionId: "session-idem", prompt: "hello", turnId: "turn-42" };

      const first = await harness.daemon.testHooks.invokeMethod("sessions.send", params, {
        connId: connection.connId,
      });
      const second = await harness.daemon.testHooks.invokeMethod("sessions.send", params, {
        connId: connection.connId,
      });

      expect(sendCount).toBe(1);
      expect(first).toMatchObject({ turnId: "turn-42", accepted: true, idempotentReplay: false });
      expect(second).toMatchObject({
        turnId: "turn-42",
        accepted: true,
        idempotentReplay: true,
        agentSessionId: "agent-9",
      });
    } finally {
      await harness.daemon.stop("test_complete").catch(() => undefined);
      harness.dispose();
    }
  });

  test("the same turn id with a different prompt is rejected as a conflict, not silently replayed", async () => {
    let sendCount = 0;
    const backend = createSessionBackendStub({
      sendPrompt: async (sessionId) => {
        sendCount += 1;
        return { sessionId, agentSessionId: "agent-1", turnId: "turn-9", accepted: true };
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });
    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-conflict",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: SILENT_SOCKET,
      });

      await harness.daemon.testHooks.invokeMethod(
        "sessions.send",
        { sessionId: "session-conflict", prompt: "first prompt", turnId: "turn-9" },
        { connId: connection.connId },
      );

      let conflict: unknown;
      try {
        await harness.daemon.testHooks.invokeMethod(
          "sessions.send",
          { sessionId: "session-conflict", prompt: "DIFFERENT prompt", turnId: "turn-9" },
          { connId: connection.connId },
        );
      } catch (error) {
        conflict = error;
      }

      // The reused turn id with a different prompt must not run, and must not be
      // accepted as an idempotent replay of the first prompt.
      expect(sendCount).toBe(1);
      expect(conflict).toMatchObject({ code: "bad_state", details: { kind: "prompt_conflict" } });
    } finally {
      await harness.daemon.stop("test_complete").catch(() => undefined);
      harness.dispose();
    }
  });

  test("a duplicate active turn id resolves as idempotent success instead of erroring", async () => {
    const backend = createSessionBackendStub({
      sendPrompt: async () => {
        throw new SessionBackendStateError(
          "duplicate_active_turn_id",
          "duplicate active turn id: turn-7",
        );
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });
    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-dup",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: SILENT_SOCKET,
      });

      const result = await harness.daemon.testHooks.invokeMethod(
        "sessions.send",
        { sessionId: "session-dup", prompt: "hello", turnId: "turn-7" },
        { connId: connection.connId },
      );

      expect(result).toMatchObject({
        sessionId: "session-dup",
        turnId: "turn-7",
        accepted: true,
        idempotentReplay: true,
      });
    } finally {
      await harness.daemon.stop("test_complete").catch(() => undefined);
      harness.dispose();
    }
  });

  test("a send without a client turn id stays non-idempotent and runs each time", async () => {
    let sendCount = 0;
    const backend = createSessionBackendStub({
      sendPrompt: async (sessionId) => {
        sendCount += 1;
        return { sessionId, turnId: `server-${sendCount}`, accepted: true };
      },
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });
    try {
      const connection = harness.daemon.testHooks.registerConnection({
        connId: "conn-anon",
        authenticatedToken: harness.daemon.testHooks.getAuthToken(),
        socket: SILENT_SOCKET,
      });
      const params = { sessionId: "session-anon", prompt: "hello" };

      await harness.daemon.testHooks.invokeMethod("sessions.send", params, {
        connId: connection.connId,
      });
      await harness.daemon.testHooks.invokeMethod("sessions.send", params, {
        connId: connection.connId,
      });

      expect(sendCount).toBe(2);
    } finally {
      await harness.daemon.stop("test_complete").catch(() => undefined);
      harness.dispose();
    }
  });
});
