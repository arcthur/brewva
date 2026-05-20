import { randomBytes } from "node:crypto";
import { BrewvaContext, BrewvaEffect, BrewvaLayer } from "@brewva/brewva-effect/primitives";
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

export interface ManagedExecProcessRegistry {
  readonly runningSessions: Map<string, ManagedExecRunningSession>;
  readonly finishedSessions: Map<string, ManagedExecFinishedSession>;
  readonly runningBoxSessions: Map<string, ManagedBoxExecRunningSession>;
  readonly finishedBoxSessions: Map<string, ManagedBoxExecFinishedSession>;
}

export function createManagedExecProcessRegistry(): ManagedExecProcessRegistry {
  return {
    runningSessions: new Map<string, ManagedExecRunningSession>(),
    finishedSessions: new Map<string, ManagedExecFinishedSession>(),
    runningBoxSessions: new Map<string, ManagedBoxExecRunningSession>(),
    finishedBoxSessions: new Map<string, ManagedBoxExecFinishedSession>(),
  };
}

export async function disposeManagedExecProcessRegistry(
  registry: ManagedExecProcessRegistry,
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
}

const makeManagedExecProcessRegistry = BrewvaEffect.fn("tools.exec.processRegistry.make")(
  function* () {
    const registry = createManagedExecProcessRegistry();
    yield* BrewvaEffect.addFinalizer(() =>
      BrewvaEffect.promise(() => disposeManagedExecProcessRegistry(registry)),
    );
    return registry;
  },
);

export class ManagedExecProcessRegistryService extends BrewvaContext.Service<
  ManagedExecProcessRegistryService,
  ManagedExecProcessRegistry
>()("@brewva/Tools/ManagedExecProcessRegistry") {
  static layer() {
    return BrewvaLayer.effect(this, makeManagedExecProcessRegistry());
  }
}

export const defaultManagedExecProcessRegistry = createManagedExecProcessRegistry();
export const runningSessions = defaultManagedExecProcessRegistry.runningSessions;
export const finishedSessions = defaultManagedExecProcessRegistry.finishedSessions;
export const runningBoxSessions = defaultManagedExecProcessRegistry.runningBoxSessions;
export const finishedBoxSessions = defaultManagedExecProcessRegistry.finishedBoxSessions;

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
