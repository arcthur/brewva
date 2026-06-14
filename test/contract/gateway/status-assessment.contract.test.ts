import { describe, expect, test } from "bun:test";
import { createDaemonHarness, createSessionBackendStub } from "./gateway-control-plane.helpers.js";

interface DeepAssessment {
  assessment: {
    verdict: "ok" | "inconclusive";
    inconclusive: Array<{ subject: string; reason: string; sessionId?: string }>;
  };
}

function workerInfo(sessionId: string, ready: boolean, agentSessionId?: string) {
  return {
    sessionId,
    pid: 1234,
    startedAt: 0,
    lastHeartbeatAt: 0,
    lastActivityAt: 0,
    pendingRequests: 0,
    ready,
    ...(agentSessionId ? { agentSessionId } : {}),
  };
}

describe("gateway contract: honest status assessment", () => {
  test("status.deep is inconclusive while a worker has not reported readiness", async () => {
    const backend = createSessionBackendStub({
      // A recovered worker can already carry an agent session id while still
      // spawning; readiness — not that id — drives the verdict.
      listWorkers: () => [workerInfo("session-pending", false, "agent-recovered")],
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });
    try {
      const deep = (await harness.daemon.testHooks.invokeMethod(
        "status.deep",
        {},
        {},
      )) as DeepAssessment;

      expect(deep.assessment.verdict).toBe("inconclusive");
      expect(deep.assessment.inconclusive).toContainEqual({
        subject: "worker",
        reason: "worker_not_ready",
        sessionId: "session-pending",
      });
    } finally {
      await harness.daemon.stop("test_complete").catch(() => undefined);
      harness.dispose();
    }
  });

  test("status.deep is ok once every worker has reported readiness", async () => {
    const backend = createSessionBackendStub({
      listWorkers: () => [workerInfo("session-ready", true, "agent-1")],
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });
    try {
      const deep = (await harness.daemon.testHooks.invokeMethod(
        "status.deep",
        {},
        {},
      )) as DeepAssessment;

      expect(deep.assessment.verdict).toBe("ok");
      expect(deep.assessment.inconclusive).toEqual([]);
    } finally {
      await harness.daemon.stop("test_complete").catch(() => undefined);
      harness.dispose();
    }
  });
});
