import { describe, expect, test } from "bun:test";
import { resolveRuntimeEventLogPath } from "@brewva/brewva-runtime/internal";
import {
  ensureSessionShutdownRecorded,
  recordAbnormalSessionShutdown,
  recordSessionShutdownReceiptToEventLogIfMissing,
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

    const shutdownEvents = runtime.inspect.events.query(sessionId, {
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

    const shutdownEvents = runtime.inspect.events.query(sessionId, {
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

  test("records shutdown receipt directly to an event log path once", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "runtime-utils-event-log";
    const eventLogPath = resolveRuntimeEventLogPath(runtime, sessionId);

    expect(
      recordSessionShutdownReceiptToEventLogIfMissing({
        eventLogPath,
        sessionId,
        reason: "abnormal_process_exit",
        source: "session_supervisor_registry_recovery",
        workerSessionId: "worker-session-2",
      }),
    ).toBe(true);
    expect(
      recordSessionShutdownReceiptToEventLogIfMissing({
        eventLogPath,
        sessionId,
        reason: "abnormal_process_exit",
        source: "session_supervisor_registry_recovery",
        workerSessionId: "worker-session-2",
      }),
    ).toBe(false);

    const shutdownEvents = runtime.inspect.events.query(sessionId, {
      type: "session_shutdown",
    });
    expect(shutdownEvents).toHaveLength(1);
    expect(shutdownEvents[0]?.payload).toMatchObject({
      reason: "abnormal_process_exit",
      source: "session_supervisor_registry_recovery",
      workerSessionId: "worker-session-2",
      recoveredFromRegistry: false,
    });
  });
});
