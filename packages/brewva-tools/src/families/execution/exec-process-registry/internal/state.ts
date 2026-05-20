import { randomBytes } from "node:crypto";
import { differenceInMilliseconds } from "date-fns";
import {
  FINISHED_TTL_MS,
  type ManagedBoxExecFinishedSession,
  type ManagedBoxExecRunningSession,
  type ManagedExecBackend,
  type ManagedExecFinishedSession,
  type ManagedExecRunningSession,
  type ManagedOutputSession,
  type ManagedSession,
} from "../types.js";
import type { ManagedOutputSubscriber } from "./output.js";

export interface ManagedExecProcessRegistryState {
  readonly runningSessions: Map<string, ManagedExecRunningSession>;
  readonly finishedSessions: Map<string, ManagedExecFinishedSession>;
  readonly runningBoxSessions: Map<string, ManagedBoxExecRunningSession>;
  readonly finishedBoxSessions: Map<string, ManagedBoxExecFinishedSession>;
  readonly outputSubscribers: Map<string, Set<ManagedOutputSubscriber>>;
}

export function createManagedExecProcessRegistryState(): ManagedExecProcessRegistryState {
  return {
    runningSessions: new Map<string, ManagedExecRunningSession>(),
    finishedSessions: new Map<string, ManagedExecFinishedSession>(),
    runningBoxSessions: new Map<string, ManagedBoxExecRunningSession>(),
    finishedBoxSessions: new Map<string, ManagedBoxExecFinishedSession>(),
    outputSubscribers: new Map<string, Set<ManagedOutputSubscriber>>(),
  };
}

export async function disposeManagedExecProcessRegistry(
  registry: ManagedExecProcessRegistryState,
): Promise<void> {
  const terminateHost = [...registry.runningSessions.values()].map(async (session) => {
    session.removed = true;
    const timeoutHandle = session.timeoutHandle;
    session.timeoutHandle = undefined;
    await timeoutHandle?.close();
    if (!session.exited) {
      try {
        session.child.kill("SIGKILL");
      } catch {}
    }
  });
  const terminateBox = [...registry.runningBoxSessions.values()].map(async (session) => {
    session.removed = true;
    const timeoutHandle = session.timeoutHandle;
    session.timeoutHandle = undefined;
    await timeoutHandle?.close();
    if (!session.exited) {
      try {
        await session.execution.kill("SIGKILL");
      } catch {}
    }
  });

  await Promise.allSettled([...terminateHost, ...terminateBox]);
  registry.runningSessions.clear();
  registry.finishedSessions.clear();
  registry.runningBoxSessions.clear();
  registry.finishedBoxSessions.clear();
  registry.outputSubscribers.clear();
}

export function cleanupExpiredFinishedSessions(
  registry: ManagedExecProcessRegistryState,
  now = Date.now(),
): void {
  for (const [sessionId, session] of registry.finishedSessions.entries()) {
    if (differenceInMilliseconds(now, session.endedAt) > FINISHED_TTL_MS) {
      registry.finishedSessions.delete(sessionId);
    }
  }
  for (const [sessionId, session] of registry.finishedBoxSessions.entries()) {
    if (differenceInMilliseconds(now, session.endedAt) > FINISHED_TTL_MS) {
      registry.finishedBoxSessions.delete(sessionId);
    }
  }
}

export function createSessionId(): string {
  return `proc_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function clampNonNegativeInt(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export function resolveBackend(session: Pick<ManagedOutputSession, "kind">): ManagedExecBackend {
  return session.kind.startsWith("box_") ? "box" : "host";
}

export function getManagedSession(
  registry: ManagedExecProcessRegistryState,
  ownerSessionId: string,
  sessionId: string,
): ManagedSession | undefined {
  const running = registry.runningSessions.get(sessionId);
  if (running?.ownerSessionId === ownerSessionId) return running;

  const runningBox = registry.runningBoxSessions.get(sessionId);
  if (runningBox?.ownerSessionId === ownerSessionId) return runningBox;

  const finished = registry.finishedSessions.get(sessionId);
  if (finished?.ownerSessionId === ownerSessionId) return finished;

  const finishedBox = registry.finishedBoxSessions.get(sessionId);
  if (finishedBox?.ownerSessionId === ownerSessionId) return finishedBox;

  return undefined;
}

export function isManagedSessionRunning(session: ManagedSession | undefined): boolean {
  return session?.kind === "running" || session?.kind === "box_running";
}

export function isManagedSessionFinished(
  session: ManagedSession,
): session is ManagedExecFinishedSession | ManagedBoxExecFinishedSession {
  return session.kind === "finished" || session.kind === "box_finished";
}
