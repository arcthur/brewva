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

export const runningSessions = new Map<string, ManagedExecRunningSession>();
export const finishedSessions = new Map<string, ManagedExecFinishedSession>();
export const runningBoxSessions = new Map<string, ManagedBoxExecRunningSession>();
export const finishedBoxSessions = new Map<string, ManagedBoxExecFinishedSession>();

export function cleanupExpiredFinishedSessions(now = Date.now()): void {
  for (const [sessionId, session] of finishedSessions.entries()) {
    if (differenceInMilliseconds(now, session.endedAt) > FINISHED_TTL_MS) {
      finishedSessions.delete(sessionId);
    }
  }
  for (const [sessionId, session] of finishedBoxSessions.entries()) {
    if (differenceInMilliseconds(now, session.endedAt) > FINISHED_TTL_MS) {
      finishedBoxSessions.delete(sessionId);
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
  ownerSessionId: string,
  sessionId: string,
): ManagedSession | undefined {
  const running = runningSessions.get(sessionId);
  if (running?.ownerSessionId === ownerSessionId) return running;

  const runningBox = runningBoxSessions.get(sessionId);
  if (runningBox?.ownerSessionId === ownerSessionId) return runningBox;

  const finished = finishedSessions.get(sessionId);
  if (finished?.ownerSessionId === ownerSessionId) return finished;

  const finishedBox = finishedBoxSessions.get(sessionId);
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
