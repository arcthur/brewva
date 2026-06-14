import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  BOX_EXEC_FAILED_EVENT_TYPE,
  EXEC_FAILED_EVENT_TYPE,
  projectRecentExecFailures,
} from "../../../packages/brewva-tools/src/runtime-port/verification-diagnostics.js";

interface FailureSpec {
  id?: string;
  eventType: string;
  command: string;
  backend?: "host" | "box" | "virtual_readonly";
  kind?: string;
  code?: string;
  reason?: string;
  toolCallId?: string;
  at: number;
}

function failureEvent(spec: FailureSpec): BrewvaEventRecord {
  const sandboxProfile = spec.backend ? { sandboxProfile: { backend: spec.backend } } : {};
  const failureBasis =
    spec.kind || spec.code
      ? {
          failureBasis: {
            ...(spec.kind ? { kind: spec.kind } : {}),
            ...(spec.code ? { code: spec.code } : {}),
          },
        }
      : {};
  return {
    id: spec.id ?? `evt-${spec.command}-${spec.at}`,
    sessionId: "s1",
    type: spec.eventType,
    timestamp: spec.at,
    payload: {
      commandRedacted: spec.command,
      ...sandboxProfile,
      ...failureBasis,
      ...(spec.reason ? { reason: spec.reason } : {}),
      ...(spec.toolCallId ? { toolCallId: spec.toolCallId } : {}),
    },
  };
}

function project(events: readonly BrewvaEventRecord[], scanLimitPerSandbox = 100) {
  return projectRecentExecFailures({
    hostFailures: events.filter((event) => event.type === EXEC_FAILED_EVENT_TYPE),
    boxFailures: events.filter((event) => event.type === BOX_EXEC_FAILED_EVENT_TYPE),
    scanLimitPerSandbox,
  });
}

describe("projectRecentExecFailures projects exec receipts into recent-failure detail", () => {
  test("derives the sandbox from sandboxProfile.backend, not the event type", () => {
    // exec.failed events that are actually virtual_readonly / box executions must
    // NOT be mislabeled as host.
    const { failures } = project([
      failureEvent({
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: "vr cmd",
        backend: "virtual_readonly",
        at: 3,
      }),
      failureEvent({
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: "box cmd",
        backend: "box",
        at: 2,
      }),
      failureEvent({
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: "host cmd",
        backend: "host",
        at: 1,
      }),
    ]);

    const bySandbox = new Map(
      failures.map((failure) => [failure.commandRedacted, failure.sandbox]),
    );
    expect(bySandbox.get("vr cmd")).toBe("virtual_readonly");
    expect(bySandbox.get("box cmd")).toBe("box");
    expect(bySandbox.get("host cmd")).toBe("host");
  });

  test("falls back to box for box events and unknown for profile-less exec events", () => {
    const { failures } = project([
      failureEvent({ eventType: BOX_EXEC_FAILED_EVENT_TYPE, command: "box noprofile", at: 2 }),
      failureEvent({ eventType: EXEC_FAILED_EVENT_TYPE, command: "exec noprofile", at: 1 }),
    ]);

    const bySandbox = new Map(
      failures.map((failure) => [failure.commandRedacted, failure.sandbox]),
    );
    expect(bySandbox.get("box noprofile")).toBe("box");
    // A profile-less exec.failed (pre-execution policy block) must not be guessed as host.
    expect(bySandbox.get("exec noprofile")).toBe("unknown");
  });

  test("keeps the latest failure per identical check and records its source event", () => {
    const { failures } = project([
      failureEvent({
        id: "old",
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: "bun run lint",
        backend: "host",
        kind: "execution_failure",
        code: "nonzero_exit",
        reason: "old failure",
        at: 1,
      }),
      failureEvent({
        id: "fresh",
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: "bun run lint",
        backend: "host",
        kind: "execution_failure",
        code: "nonzero_exit",
        reason: "fresh failure",
        at: 9,
      }),
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBe("fresh failure");
    expect(failures[0]!.observedAt).toBe(9);
    expect(failures[0]!.sourceEventId).toBe("fresh");
  });

  test("keeps distinct checks and orders them newest-first", () => {
    const { failures } = project([
      failureEvent({
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: "bun run lint",
        backend: "host",
        at: 1,
      }),
      failureEvent({
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: "tsc -b",
        backend: "host",
        at: 7,
      }),
    ]);

    expect(failures.map((failure) => failure.commandRedacted)).toEqual(["tsc -b", "bun run lint"]);
  });

  test("surfaces truncation instead of silently dropping history", () => {
    const events = Array.from({ length: 3 }, (_unused, index) =>
      failureEvent({
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: `cmd-${index}`,
        backend: "host",
        at: index,
      }),
    );

    expect(project(events, 100).truncated).toBe(false);
    // When the scan hits its per-sandbox limit, callers learn older failures may be missing.
    expect(project(events, 3).truncated).toBe(true);
  });

  test("ignores receipts without a redacted command", () => {
    const { failures } = project([
      { id: "x", sessionId: "s1", type: EXEC_FAILED_EVENT_TYPE, timestamp: 4, payload: {} },
      failureEvent({
        eventType: EXEC_FAILED_EVENT_TYPE,
        command: "bun run check",
        backend: "host",
        at: 8,
      }),
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.commandRedacted).toBe("bun run check");
    expect(failures[0]!.failureKind).toBe("execution_failure");
    expect(failures[0]!.failureCode).toBeNull();
  });
});
