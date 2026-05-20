function normalizeReasonToken(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

const WORKER_ABNORMAL_SOURCES = {
  init_failed: "session_worker_init",
  parent_disconnected: "session_worker_parent_disconnect",
  parent_pid_mismatch: "session_worker_bridge_watchdog",
  uncaught_exception: "session_worker_uncaught_exception",
  unhandled_rejection: "session_worker_unhandled_rejection",
} as const satisfies Record<string, string>;

export function resolveWorkerSessionShutdownReceipt(reason: string): {
  reason: string;
  source: string;
} {
  const normalized = normalizeReasonToken(reason, "shutdown");
  const abnormalSource =
    WORKER_ABNORMAL_SOURCES[normalized as keyof typeof WORKER_ABNORMAL_SOURCES];
  if (abnormalSource) {
    return {
      reason: "abnormal_process_exit",
      source: abnormalSource,
    };
  }
  switch (normalized) {
    case "bridge_timeout":
      return {
        reason: normalized,
        source: "session_worker_bridge_watchdog",
      };
    case "sigterm":
    case "sigint":
      return {
        reason: normalized,
        source: "session_worker_signal",
      };
    default:
      return {
        reason: normalized,
        source: "session_worker_shutdown",
      };
  }
}

export function resolveSubagentSessionShutdownReason(input: {
  timeoutTriggered?: boolean;
  cancellationReason?: string;
  completionReason: string;
}): string {
  const normalizedCancellation = normalizeReasonToken(input.cancellationReason, "");
  if (input.timeoutTriggered || normalizedCancellation.startsWith("timeout_")) {
    return "subagent_timeout";
  }
  if (normalizedCancellation.length === 0) {
    return normalizeReasonToken(input.completionReason, "subagent_run_complete");
  }
  if (normalizedCancellation === "cancelled_by_parent") {
    return "subagent_cancelled_by_parent";
  }
  if (normalizedCancellation.startsWith("subagent_")) {
    return normalizedCancellation;
  }
  return `subagent_cancelled_${normalizedCancellation}`;
}
