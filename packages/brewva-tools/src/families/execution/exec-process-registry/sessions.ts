import {
  BrewvaCause,
  BrewvaDeferred,
  BrewvaDuration,
  BrewvaEffect,
  BrewvaQueue,
  BrewvaStream,
  addScopedFinalizer,
  runPromiseAtBoundary,
} from "@brewva/brewva-effect";
import { subscribeManagedSessionOutput } from "./internal/output.js";
import {
  cleanupExpiredFinishedSessions,
  clampNonNegativeInt,
  finishedBoxSessions,
  finishedSessions,
  getManagedSession,
  isManagedSessionFinished,
  isManagedSessionRunning,
  resolveBackend,
  runningBoxSessions,
  runningSessions,
} from "./internal/state.js";
import {
  DEFAULT_LOG_TAIL_LINES,
  type ManagedBoxExecFinishedSession,
  type ManagedBoxExecRunningSession,
  type ManagedExecFinishedSession,
  type ManagedExecOutputEvent,
  type ManagedExecRunningSession,
  ManagedExecSessionNotFoundError,
  type ManagedSession,
  type SessionLogSlice,
} from "./types.js";

export function markSessionBackgrounded(ownerSessionId: string, sessionId: string): boolean {
  cleanupExpiredFinishedSessions();
  const running = runningSessions.get(sessionId);
  if (running && running.ownerSessionId === ownerSessionId) {
    running.backgrounded = true;
    return true;
  }
  const finished = finishedSessions.get(sessionId);
  if (finished && finished.ownerSessionId === ownerSessionId) {
    finished.backgrounded = true;
    return true;
  }
  return false;
}

export function listRunningBackgroundSessions(ownerSessionId: string): ManagedExecRunningSession[] {
  cleanupExpiredFinishedSessions();
  return [...runningSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function listRunningBoxBackgroundSessions(
  ownerSessionId: string,
): ManagedBoxExecRunningSession[] {
  cleanupExpiredFinishedSessions();
  return [...runningBoxSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function listFinishedBackgroundSessions(
  ownerSessionId: string,
): ManagedExecFinishedSession[] {
  cleanupExpiredFinishedSessions();
  return [...finishedSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function listFinishedBoxBackgroundSessions(
  ownerSessionId: string,
): ManagedBoxExecFinishedSession[] {
  cleanupExpiredFinishedSessions();
  return [...finishedBoxSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function getRunningSession(
  ownerSessionId: string,
  sessionId: string,
): ManagedExecRunningSession | undefined {
  cleanupExpiredFinishedSessions();
  const session = runningSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function getRunningBoxSession(
  ownerSessionId: string,
  sessionId: string,
): ManagedBoxExecRunningSession | undefined {
  cleanupExpiredFinishedSessions();
  const session = runningBoxSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function getFinishedSession(
  ownerSessionId: string,
  sessionId: string,
): ManagedExecFinishedSession | undefined {
  cleanupExpiredFinishedSessions();
  const session = finishedSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function getFinishedBoxSession(
  ownerSessionId: string,
  sessionId: string,
): ManagedBoxExecFinishedSession | undefined {
  cleanupExpiredFinishedSessions();
  const session = finishedBoxSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function streamManagedSessionOutput(
  ownerSessionId: string,
  sessionId: string,
): BrewvaStream.Stream<ManagedExecOutputEvent, ManagedExecSessionNotFoundError> {
  return BrewvaStream.callback(
    (queue) =>
      BrewvaEffect.gen(function* () {
        const session = getManagedSession(ownerSessionId, sessionId);
        if (!session) {
          BrewvaQueue.failCauseUnsafe(
            queue,
            BrewvaCause.fail(new ManagedExecSessionNotFoundError(sessionId)),
          );
          return;
        }

        const offerEvent = async (event: ManagedExecOutputEvent): Promise<boolean> => {
          if (event.ownerSessionId !== ownerSessionId) {
            return true;
          }
          const offered = await runPromiseAtBoundary(BrewvaQueue.offer(queue, event));
          if (event.type === "exit") {
            BrewvaQueue.endUnsafe(queue);
          }
          return offered;
        };
        const unsubscribe = subscribeManagedSessionOutput(sessionId, offerEvent);
        yield* addScopedFinalizer(unsubscribe);

        if (isManagedSessionFinished(session)) {
          void offerEvent({
            type: "exit",
            sessionId: session.id,
            ownerSessionId: session.ownerSessionId,
            backend: resolveBackend(session),
            status: session.status,
            exitCode: session.exitCode,
            exitSignal: session.exitSignal,
            emittedAt: "endedAt" in session ? session.endedAt : Date.now(),
          });
        }
      }),
    { bufferSize: 64, strategy: "suspend" },
  );
}

export function consumeManagedSessionOutputEffect<E = never, R = never>(
  ownerSessionId: string,
  sessionId: string,
  sink: (event: ManagedExecOutputEvent) => BrewvaEffect.Effect<void, E, R> | void,
): BrewvaEffect.Effect<void, ManagedExecSessionNotFoundError | E, R> {
  return streamManagedSessionOutput(ownerSessionId, sessionId).pipe(
    BrewvaStream.runForEach((event) => sink(event) ?? BrewvaEffect.void),
  );
}

export function waitForManagedSessionActivityEffect(
  ownerSessionId: string,
  sessionId: string,
  timeoutMs: number,
): BrewvaEffect.Effect<void> {
  if (timeoutMs <= 0) {
    return BrewvaEffect.void;
  }
  return BrewvaEffect.scoped(
    BrewvaEffect.gen(function* () {
      const current = getManagedSession(ownerSessionId, sessionId);
      if (!isManagedSessionRunning(current) || (current && hasPendingOutput(current))) {
        return;
      }

      const activity = yield* BrewvaDeferred.make<void>();
      const unsubscribe = subscribeManagedSessionOutput(sessionId, (event) => {
        if (event.ownerSessionId !== ownerSessionId) {
          return;
        }
        BrewvaDeferred.doneUnsafe(activity, BrewvaEffect.succeed(undefined));
      });
      yield* addScopedFinalizer(unsubscribe);

      const afterSubscribe = getManagedSession(ownerSessionId, sessionId);
      if (
        !isManagedSessionRunning(afterSubscribe) ||
        (afterSubscribe && hasPendingOutput(afterSubscribe))
      ) {
        return;
      }

      yield* BrewvaEffect.race(
        BrewvaDeferred.await(activity),
        BrewvaEffect.sleep(BrewvaDuration.millis(timeoutMs)),
      );
    }),
  );
}

export function hasPendingOutput(session: ManagedSession): boolean {
  return session.aggregated.length > session.drainCursor;
}

export function drainSessionOutput(session: ManagedSession): string {
  if (session.drainCursor > session.aggregated.length) {
    session.drainCursor = session.aggregated.length;
  }
  const next = session.aggregated.slice(session.drainCursor);
  session.drainCursor = session.aggregated.length;
  return next;
}

export function readSessionLog(
  session: ManagedSession,
  offset?: number,
  limit?: number,
): SessionLogSlice {
  const normalized = session.aggregated.replaceAll("\r\n", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }

  const totalLines = lines.length;
  const totalChars = normalized.length;
  const safeOffset =
    typeof offset === "number" && Number.isFinite(offset) ? clampNonNegativeInt(offset) : undefined;
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) ? clampNonNegativeInt(limit) : undefined;
  const usingDefaultTail = safeOffset === undefined && safeLimit === undefined;

  let start = 0;
  let end = totalLines;
  if (safeOffset !== undefined) {
    start = Math.min(safeOffset, totalLines);
  } else if (usingDefaultTail) {
    start = Math.max(0, totalLines - DEFAULT_LOG_TAIL_LINES);
  }
  if (safeLimit !== undefined) {
    end = Math.min(totalLines, start + safeLimit);
  }

  return {
    output: lines.slice(start, end).join("\n"),
    totalLines,
    totalChars,
    usingDefaultTail,
  };
}

export function deleteManagedSession(ownerSessionId: string, sessionId: string): boolean {
  cleanupExpiredFinishedSessions();
  const running = runningSessions.get(sessionId);
  if (running && running.ownerSessionId === ownerSessionId) {
    if (!running.exited) return false;
    running.removed = true;
    runningSessions.delete(sessionId);
    finishedSessions.delete(sessionId);
    return true;
  }

  const finished = finishedSessions.get(sessionId);
  if (finished && finished.ownerSessionId === ownerSessionId) {
    finished.removed = true;
    finishedSessions.delete(sessionId);
    return true;
  }

  const runningBox = runningBoxSessions.get(sessionId);
  if (runningBox && runningBox.ownerSessionId === ownerSessionId) {
    if (!runningBox.exited) return false;
    runningBox.removed = true;
    runningBoxSessions.delete(sessionId);
    finishedBoxSessions.delete(sessionId);
    return true;
  }

  const finishedBox = finishedBoxSessions.get(sessionId);
  if (finishedBox && finishedBox.ownerSessionId === ownerSessionId) {
    finishedBox.removed = true;
    finishedBoxSessions.delete(sessionId);
    return true;
  }
  return false;
}
