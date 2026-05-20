import type { BoundaryTimeoutHandle } from "@brewva/brewva-effect";
import {
  type ManagedBoxExecFinishedSession,
  type ManagedBoxExecRunningSession,
  type ManagedExecFinishedSession,
  type ManagedExecResultStatus,
  type ManagedExecRunningSession,
} from "../types.js";
import { appendOutput, publishOutputEvent } from "./output.js";
import { cleanupExpiredFinishedSessions, type ManagedExecProcessRegistryState } from "./state.js";

export function closeSessionTimeout(session: { timeoutHandle?: BoundaryTimeoutHandle }): void {
  const timeoutHandle = session.timeoutHandle;
  if (!timeoutHandle) {
    return;
  }
  session.timeoutHandle = undefined;
  void timeoutHandle.close();
}

export function finalizeBoxSession(
  registry: ManagedExecProcessRegistryState,
  session: ManagedBoxExecRunningSession,
  params: {
    exitCode: number | null;
    output?: string;
    timedOut?: boolean;
    error?: string;
  },
): ManagedBoxExecFinishedSession {
  closeSessionTimeout(session);
  registry.runningBoxSessions.delete(session.id);
  if (params.output) {
    appendOutput(registry, session, params.output, "system");
  }
  if (params.error) {
    appendOutput(registry, session, `\n\n${params.error}`, "system");
  }
  if (params.timedOut) {
    session.timedOut = true;
  }

  const status: ManagedExecResultStatus =
    params.exitCode === 0 && !session.timedOut ? "completed" : "failed";
  const finished: ManagedBoxExecFinishedSession = {
    id: session.id,
    kind: "box_finished",
    ownerSessionId: session.ownerSessionId,
    command: session.command,
    cwd: session.cwd,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    pid: null,
    boxId: session.boxId,
    executionId: session.executionId,
    fingerprint: session.fingerprint,
    backgrounded: session.backgrounded,
    exited: true,
    exitCode: params.exitCode,
    exitSignal: null,
    aggregated: session.aggregated,
    tail: session.tail,
    truncated: session.truncated,
    drainCursor: session.drainCursor,
    timedOut: session.timedOut,
    removed: session.removed,
    status,
  };

  if (!finished.removed) {
    registry.finishedBoxSessions.set(finished.id, finished);
    cleanupExpiredFinishedSessions(registry);
  }
  void publishOutputEvent(registry, {
    type: "exit",
    sessionId: finished.id,
    ownerSessionId: finished.ownerSessionId,
    backend: "box",
    status: finished.status,
    exitCode: finished.exitCode,
    exitSignal: finished.exitSignal,
    emittedAt: finished.endedAt,
  });
  return finished;
}

export function finalizeSession(
  registry: ManagedExecProcessRegistryState,
  session: ManagedExecRunningSession,
): ManagedExecFinishedSession {
  closeSessionTimeout(session);
  registry.runningSessions.delete(session.id);

  const status: ManagedExecResultStatus =
    session.exitCode === 0 && session.exitSignal == null && !session.timedOut
      ? "completed"
      : "failed";
  const finished: ManagedExecFinishedSession = {
    id: session.id,
    kind: "finished",
    ownerSessionId: session.ownerSessionId,
    command: session.command,
    cwd: session.cwd,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    pid: session.pid,
    backgrounded: session.backgrounded,
    exited: true,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    aggregated: session.aggregated,
    tail: session.tail,
    truncated: session.truncated,
    drainCursor: session.drainCursor,
    timedOut: session.timedOut,
    removed: session.removed,
    status,
  };

  if (!finished.removed) {
    registry.finishedSessions.set(finished.id, finished);
    cleanupExpiredFinishedSessions(registry);
  }
  void publishOutputEvent(registry, {
    type: "exit",
    sessionId: finished.id,
    ownerSessionId: finished.ownerSessionId,
    backend: "host",
    status: finished.status,
    exitCode: finished.exitCode,
    exitSignal: finished.exitSignal,
    emittedAt: finished.endedAt,
  });
  return finished;
}
