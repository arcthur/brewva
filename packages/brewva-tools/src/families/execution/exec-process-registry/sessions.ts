import { addScopedFinalizer } from "@brewva/brewva-effect";
import {
  BrewvaDeferred,
  BrewvaDuration,
  BrewvaEffect,
  BrewvaStream,
} from "@brewva/brewva-effect/primitives";
import { createAsyncBridge } from "@brewva/brewva-std/async";
import { subscribeManagedSessionOutput } from "./internal/output.js";
import {
  cleanupExpiredFinishedSessions,
  clampNonNegativeInt,
  getManagedSession,
  isManagedSessionFinished,
  isManagedSessionRunning,
  type ManagedExecProcessRegistryState,
  resolveBackend,
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

export function markSessionBackgrounded(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
): boolean {
  cleanupExpiredFinishedSessions(registry);
  const running = registry.runningSessions.get(sessionId);
  if (running && running.ownerSessionId === ownerSessionId) {
    running.backgrounded = true;
    return true;
  }
  const finished = registry.finishedSessions.get(sessionId);
  if (finished && finished.ownerSessionId === ownerSessionId) {
    finished.backgrounded = true;
    return true;
  }
  return false;
}

export function listRunningBackgroundSessions(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
): ManagedExecRunningSession[] {
  cleanupExpiredFinishedSessions(registry);
  return [...registry.runningSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function listRunningBoxBackgroundSessions(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
): ManagedBoxExecRunningSession[] {
  cleanupExpiredFinishedSessions(registry);
  return [...registry.runningBoxSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function listFinishedBackgroundSessions(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
): ManagedExecFinishedSession[] {
  cleanupExpiredFinishedSessions(registry);
  return [...registry.finishedSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function listFinishedBoxBackgroundSessions(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
): ManagedBoxExecFinishedSession[] {
  cleanupExpiredFinishedSessions(registry);
  return [...registry.finishedBoxSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function getRunningSession(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
): ManagedExecRunningSession | undefined {
  cleanupExpiredFinishedSessions(registry);
  const session = registry.runningSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function getRunningBoxSession(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
): ManagedBoxExecRunningSession | undefined {
  cleanupExpiredFinishedSessions(registry);
  const session = registry.runningBoxSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function getFinishedSession(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
): ManagedExecFinishedSession | undefined {
  cleanupExpiredFinishedSessions(registry);
  const session = registry.finishedSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function getFinishedBoxSession(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
): ManagedBoxExecFinishedSession | undefined {
  cleanupExpiredFinishedSessions(registry);
  const session = registry.finishedBoxSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function streamManagedSessionOutput(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
): BrewvaStream.Stream<ManagedExecOutputEvent, ManagedExecSessionNotFoundError> {
  return BrewvaStream.unwrap(
    BrewvaEffect.gen(function* () {
      const session = getManagedSession(registry, ownerSessionId, sessionId);
      if (!session) {
        return yield* BrewvaEffect.fail(new ManagedExecSessionNotFoundError(sessionId));
      }

      let unsubscribe: (() => void) | undefined;
      const bridge = createAsyncBridge<ManagedExecOutputEvent>({
        capacity: 64,
        onCancel: () => unsubscribe?.(),
      });
      const offerEvent = async (event: ManagedExecOutputEvent): Promise<boolean> => {
        if (event.ownerSessionId !== ownerSessionId) {
          return true;
        }
        await bridge.write(event);
        if (event.type === "exit") {
          bridge.close();
        }
        return true;
      };
      unsubscribe = subscribeManagedSessionOutput(registry, sessionId, offerEvent);
      yield* addScopedFinalizer(() => {
        unsubscribe?.();
        bridge.abort("managed session output stream closed");
      });

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
      return BrewvaStream.fromAsyncIterable(
        bridge,
        () => new ManagedExecSessionNotFoundError(sessionId),
      );
    }),
  );
}

export function consumeManagedSessionOutputEffect<E = never, R = never>(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
  sink: (event: ManagedExecOutputEvent) => BrewvaEffect.Effect<void, E, R> | void,
): BrewvaEffect.Effect<void, ManagedExecSessionNotFoundError | E, R> {
  return streamManagedSessionOutput(registry, ownerSessionId, sessionId).pipe(
    BrewvaStream.runForEach((event) => sink(event) ?? BrewvaEffect.void),
  );
}

export function waitForManagedSessionActivityEffect(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
  timeoutMs: number,
): BrewvaEffect.Effect<void> {
  if (timeoutMs <= 0) {
    return BrewvaEffect.void;
  }
  return BrewvaEffect.scoped(
    BrewvaEffect.gen(function* () {
      const current = getManagedSession(registry, ownerSessionId, sessionId);
      if (!isManagedSessionRunning(current) || (current && hasPendingOutput(current))) {
        return;
      }

      const activity = yield* BrewvaDeferred.make<void>();
      const unsubscribe = subscribeManagedSessionOutput(registry, sessionId, (event) => {
        if (event.ownerSessionId !== ownerSessionId) {
          return;
        }
        BrewvaDeferred.doneUnsafe(activity, BrewvaEffect.succeed(undefined));
      });
      yield* addScopedFinalizer(unsubscribe);

      const afterSubscribe = getManagedSession(registry, ownerSessionId, sessionId);
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

export function deleteManagedSession(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
): boolean {
  cleanupExpiredFinishedSessions(registry);
  const running = registry.runningSessions.get(sessionId);
  if (running && running.ownerSessionId === ownerSessionId) {
    if (!running.exited) return false;
    running.removed = true;
    registry.runningSessions.delete(sessionId);
    registry.finishedSessions.delete(sessionId);
    return true;
  }

  const finished = registry.finishedSessions.get(sessionId);
  if (finished && finished.ownerSessionId === ownerSessionId) {
    finished.removed = true;
    registry.finishedSessions.delete(sessionId);
    return true;
  }

  const runningBox = registry.runningBoxSessions.get(sessionId);
  if (runningBox && runningBox.ownerSessionId === ownerSessionId) {
    if (!runningBox.exited) return false;
    runningBox.removed = true;
    registry.runningBoxSessions.delete(sessionId);
    registry.finishedBoxSessions.delete(sessionId);
    return true;
  }

  const finishedBox = registry.finishedBoxSessions.get(sessionId);
  if (finishedBox && finishedBox.ownerSessionId === ownerSessionId) {
    finishedBox.removed = true;
    registry.finishedBoxSessions.delete(sessionId);
    return true;
  }
  return false;
}
