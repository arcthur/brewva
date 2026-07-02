import { describe, expect, test } from "bun:test";
import { SESSION_SHUTDOWN_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import {
  ensureSessionShutdownRecorded,
  recordAbnormalSessionShutdown,
  recordSessionShutdownIfMissing,
} from "../../../packages/brewva-gateway/src/utils/runtime.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("gateway runtime utils", () => {
  test("records abnormal session shutdown payload once", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "runtime-utils-shutdown";

    recordAbnormalSessionShutdown(runtime, {
      sessionId,
      source: "uncaught_exception",
      error: new Error("worker exploded"),
    });
    ensureSessionShutdownRecorded(runtime, sessionId);

    const shutdownEvents = runtime.ops.events.records.query(sessionId, {
      type: "session_shutdown",
    });
    expect(shutdownEvents).toHaveLength(1);
    expect(shutdownEvents[0]?.payload).toEqual({
      reason: "abnormal_process_exit",
      source: "uncaught_exception",
      error: "worker exploded",
      exitCode: null,
      signal: null,
      workerSessionId: null,
      recoveredFromRegistry: false,
    });
  });

  test("records synthesized shutdown metadata once for supervisor reconciliation", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "runtime-utils-synthesized";

    recordSessionShutdownIfMissing(runtime, {
      sessionId,
      reason: "process_exit_without_terminal_receipt",
      source: "session_supervisor_worker_exit",
      exitCode: 0,
      signal: "SIGKILL",
      workerSessionId: "worker-session-1",
      recoveredFromRegistry: true,
    });
    ensureSessionShutdownRecorded(runtime, sessionId);

    const shutdownEvents = runtime.ops.events.records.query(sessionId, {
      type: "session_shutdown",
    });
    expect(shutdownEvents).toHaveLength(1);
    expect(shutdownEvents[0]?.payload).toMatchObject({
      reason: "process_exit_without_terminal_receipt",
      source: "session_supervisor_worker_exit",
      exitCode: 0,
      signal: "SIGKILL",
      workerSessionId: "worker-session-1",
      recoveredFromRegistry: true,
    });
  });

  test("shutdown receipts round-trip through SESSION_SHUTDOWN_EVENT_TYPE (producer seam)", () => {
    // The lifecycle builder writes and every reader (idempotence probe,
    // session-wire closed frame, event-stream attempt-binding cleanup) queries
    // this one constant; the dot-form constant vs underscore tape spelling
    // split kept the constant-side consumers silently inert before the
    // contract-liveness audit.
    const runtime = createRuntimeFixture();
    const sessionId = "runtime-utils-constant-roundtrip";

    ensureSessionShutdownRecorded(runtime, sessionId, { reason: "test" });
    ensureSessionShutdownRecorded(runtime, sessionId, { reason: "duplicate" });

    const shutdownEvents = runtime.ops.events.records.query(sessionId, {
      type: SESSION_SHUTDOWN_EVENT_TYPE,
    });
    expect(shutdownEvents).toHaveLength(1);
    expect(SESSION_SHUTDOWN_EVENT_TYPE).toBe("session_shutdown");
  });
});
