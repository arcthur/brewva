import { describe, expect, test } from "bun:test";
import {
  resolveSubagentSessionShutdownReason,
  resolveWorkerSessionShutdownReceipt,
} from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/shutdown-receipts.js";

describe("session shutdown receipt policies", () => {
  test("worker shutdown receipts map abnormal exits to a canonical terminal reason with semantic sources", () => {
    expect(resolveWorkerSessionShutdownReceipt("parent_disconnected")).toEqual({
      reason: "abnormal_process_exit",
      source: "session_worker_parent_disconnect",
    });
    expect(resolveWorkerSessionShutdownReceipt("parent_pid_mismatch")).toEqual({
      reason: "abnormal_process_exit",
      source: "session_worker_bridge_watchdog",
    });
    expect(resolveWorkerSessionShutdownReceipt("uncaught_exception")).toEqual({
      reason: "abnormal_process_exit",
      source: "session_worker_uncaught_exception",
    });
    expect(resolveWorkerSessionShutdownReceipt("unhandled_rejection")).toEqual({
      reason: "abnormal_process_exit",
      source: "session_worker_unhandled_rejection",
    });
    expect(resolveWorkerSessionShutdownReceipt("init_failed")).toEqual({
      reason: "abnormal_process_exit",
      source: "session_worker_init",
    });
  });

  test("worker shutdown receipts preserve explicit non-abnormal reasons while keeping semantic sources", () => {
    expect(resolveWorkerSessionShutdownReceipt("bridge_timeout")).toEqual({
      reason: "bridge_timeout",
      source: "session_worker_bridge_watchdog",
    });
    expect(resolveWorkerSessionShutdownReceipt("sigterm")).toEqual({
      reason: "sigterm",
      source: "session_worker_signal",
    });
    expect(resolveWorkerSessionShutdownReceipt("shutdown")).toEqual({
      reason: "shutdown",
      source: "session_worker_shutdown",
    });
  });

  test("subagent shutdown reasons preserve terminal cause precision without leaking timeout internals", () => {
    expect(
      resolveSubagentSessionShutdownReason({
        completionReason: "subagent_run_complete",
      }),
    ).toBe("subagent_run_complete");
    expect(
      resolveSubagentSessionShutdownReason({
        cancellationReason: "manual_stop",
        completionReason: "subagent_run_complete",
      }),
    ).toBe("subagent_cancelled_manual_stop");
    expect(
      resolveSubagentSessionShutdownReason({
        cancellationReason: "cancelled_by_parent",
        completionReason: "subagent_run_complete",
      }),
    ).toBe("subagent_cancelled_by_parent");
    expect(
      resolveSubagentSessionShutdownReason({
        cancellationReason: "timeout:3000",
        completionReason: "subagent_run_complete",
      }),
    ).toBe("subagent_timeout");
    expect(
      resolveSubagentSessionShutdownReason({
        timeoutTriggered: true,
        cancellationReason: "manual_stop",
        completionReason: "subagent_run_complete",
      }),
    ).toBe("subagent_timeout");
  });
});
