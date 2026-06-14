import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  BOX_EXEC_FAILED_EVENT_TYPE,
  EXEC_FAILED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";

export type ExecFailureSandbox = "host" | "box" | "virtual_readonly" | "unknown";

export interface RecentExecFailure {
  readonly sandbox: ExecFailureSandbox;
  readonly commandRedacted: string;
  readonly failureKind: string;
  readonly failureCode: string | null;
  readonly reason: string | null;
  readonly toolCallId: string | null;
  readonly observedAt: number;
  readonly sourceEventId: string;
}

export interface RecentExecFailureProjection {
  /** Latest failure per (sandbox, command, failureKind, failureCode), newest first. */
  readonly failures: readonly RecentExecFailure[];
  /**
   * True when the scan hit its per-sandbox limit, so older failures may be
   * missing. Surfaced instead of silently dropping history.
   */
  readonly truncated: boolean;
}

const KNOWN_BACKENDS: ReadonlySet<string> = new Set(["host", "box", "virtual_readonly"]);

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// The execution sandbox is authoritative on the audit payload's `sandboxProfile`
// (host, box, or virtual_readonly), not the event type: `exec.failed` carries
// virtual_readonly and box failures too. Fall back to the event type only when
// the profile is absent (pre-execution policy blocks), and never guess "host".
function readSandbox(payload: Record<string, unknown>, eventType: string): ExecFailureSandbox {
  const profile = payload.sandboxProfile;
  if (profile && typeof profile === "object") {
    const backend = (profile as Record<string, unknown>).backend;
    if (typeof backend === "string" && KNOWN_BACKENDS.has(backend)) {
      return backend as ExecFailureSandbox;
    }
  }
  return eventType === BOX_EXEC_FAILED_EVENT_TYPE ? "box" : "unknown";
}

function readFailure(event: BrewvaEventRecord): RecentExecFailure | null {
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : undefined;
  if (!payload) {
    return null;
  }
  // Surface only the redaction-safe command identity; raw command text never
  // leaves the exec audit layer.
  const commandRedacted = readString(payload.commandRedacted);
  if (!commandRedacted) {
    return null;
  }
  const failureBasis =
    payload.failureBasis && typeof payload.failureBasis === "object"
      ? (payload.failureBasis as Record<string, unknown>)
      : undefined;
  return {
    sandbox: readSandbox(payload, event.type),
    commandRedacted,
    failureKind: readString(failureBasis?.kind) ?? "execution_failure",
    failureCode: readString(failureBasis?.code),
    reason: readString(payload.reason),
    toolCallId: readString(payload.toolCallId),
    observedAt: typeof event.timestamp === "number" ? event.timestamp : 0,
    sourceEventId: event.id,
  };
}

/**
 * Project recent exec and box-exec failure receipts into a deduplicated,
 * newest-first recent-failure view, deterministic from committed tape receipts.
 *
 * This is failure history, not current verification state: host successes are
 * not recorded as events, so a check that failed then later passed still
 * appears here. Current verification state remains owned by
 * `verification.outcome.recorded`; this projection only enriches it with the
 * exec-level detail behind a failure.
 */
export function projectRecentExecFailures(input: {
  readonly hostFailures: readonly BrewvaEventRecord[];
  readonly boxFailures: readonly BrewvaEventRecord[];
  readonly scanLimitPerSandbox: number;
}): RecentExecFailureProjection {
  const truncated =
    input.hostFailures.length >= input.scanLimitPerSandbox ||
    input.boxFailures.length >= input.scanLimitPerSandbox;

  const latestByCheck = new Map<string, RecentExecFailure>();
  for (const event of [...input.hostFailures, ...input.boxFailures]) {
    const failure = readFailure(event);
    if (!failure) {
      continue;
    }
    const key = JSON.stringify([
      failure.sandbox,
      failure.commandRedacted,
      failure.failureKind,
      failure.failureCode,
    ]);
    const existing = latestByCheck.get(key);
    if (!existing || failure.observedAt >= existing.observedAt) {
      latestByCheck.set(key, failure);
    }
  }

  const failures = [...latestByCheck.values()].toSorted((left, right) => {
    if (left.observedAt !== right.observedAt) {
      return right.observedAt - left.observedAt;
    }
    return left.commandRedacted.localeCompare(right.commandRedacted);
  });

  return { failures, truncated };
}

export { EXEC_FAILED_EVENT_TYPE, BOX_EXEC_FAILED_EVENT_TYPE };
