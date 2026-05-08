import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  BrewvaBoundaryFailure,
  BrewvaEffect,
  startScopedTimeout,
  type BrewvaScope,
} from "@brewva/brewva-effect";
import { resolveShellConfig as getShellConfig } from "@brewva/brewva-substrate/host-api";
import { finalizeSession } from "./internal/lifecycle.js";
import { appendOutput, appendOutputWithBackpressure } from "./internal/output.js";
import {
  cleanupExpiredFinishedSessions,
  createSessionId,
  runningSessions,
} from "./internal/state.js";
import type {
  ManagedExecFinishedSession,
  ManagedExecRunningSession,
  ManagedExecStartError,
  ManagedExecStartInput,
  ManagedExecStartResult,
} from "./types.js";

function tryKillByPid(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // fall through
    }
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch {
    if (process.platform === "win32" && signal === "SIGKILL") {
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function terminateRunningSession(
  session: ManagedExecRunningSession,
  force = false,
): boolean {
  if (session.exited) return false;
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  const byPid = session.pid !== null ? tryKillByPid(session.pid, signal) : false;

  if (!byPid) {
    try {
      session.child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export function startManagedExec(input: ManagedExecStartInput): ManagedExecStartResult {
  cleanupExpiredFinishedSessions();

  const id = createSessionId();
  const cwd = resolve(input.cwd);
  const { shell, args } = getShellConfig();
  const child = spawn(shell, [...args, input.command], {
    cwd,
    env: input.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const session: ManagedExecRunningSession = {
    id,
    kind: "running",
    ownerSessionId: input.ownerSessionId,
    command: input.command,
    cwd,
    startedAt: Date.now(),
    pid: child.pid ?? null,
    child,
    stdin: child.stdin,
    backgrounded: false,
    exited: false,
    exitCode: null,
    exitSignal: null,
    aggregated: "",
    tail: "",
    truncated: false,
    drainCursor: 0,
    timedOut: false,
    removed: false,
  };
  runningSessions.set(session.id, session);

  if (typeof input.timeoutSec === "number" && input.timeoutSec > 0) {
    const timeoutMs = Math.trunc(input.timeoutSec * 1000);
    session.timeoutHandle = startScopedTimeout({
      delayMs: timeoutMs,
      run: () =>
        BrewvaEffect.sync(() => {
          if (session.exited || session.removed) return;
          session.timedOut = true;
          appendOutput(
            session,
            `\n\nCommand timed out after ${input.timeoutSec} seconds.`,
            "system",
          );
          terminateRunningSession(session, true);
        }),
    });
  }

  const completion = new Promise<ManagedExecFinishedSession>((resolveCompletion) => {
    const settle = (params: {
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
      spawnError?: string;
    }) => {
      if (session.exited) return;
      session.exited = true;
      session.exitCode = params.exitCode;
      session.exitSignal = params.exitSignal;
      if (params.spawnError) {
        appendOutput(session, `\n\n${params.spawnError}`, "system");
      }
      resolveCompletion(finalizeSession(session));
    };

    child.stdout.on("data", (chunk) => {
      child.stdout.pause();
      void appendOutputWithBackpressure(session, chunk, "stdout").finally(() => {
        if (!session.exited && !session.removed) {
          child.stdout.resume();
        }
      });
    });
    child.stderr.on("data", (chunk) => {
      child.stderr.pause();
      void appendOutputWithBackpressure(session, chunk, "stderr").finally(() => {
        if (!session.exited && !session.removed) {
          child.stderr.resume();
        }
      });
    });
    child.on("error", (error) => {
      settle({
        exitCode: null,
        exitSignal: null,
        spawnError: `Failed to spawn command: ${error.message}`,
      });
    });
    child.on("close", (code, signal) => {
      settle({
        exitCode: code ?? null,
        exitSignal: signal ?? null,
      });
    });
  });

  return { session, completion };
}

export function startManagedExecEffect(
  input: ManagedExecStartInput,
): BrewvaEffect.Effect<ManagedExecStartResult, ManagedExecStartError> {
  return BrewvaEffect.tryPromise({
    try: () => Promise.resolve(startManagedExec(input)),
    catch: (error) =>
      error instanceof BrewvaBoundaryFailure
        ? error
        : new BrewvaBoundaryFailure({
            message: "managedExec.start failed",
            cause: error,
          }),
  });
}

export function scopedManagedExec(
  input: ManagedExecStartInput,
): BrewvaEffect.Effect<ManagedExecStartResult, ManagedExecStartError, BrewvaScope.Scope> {
  return BrewvaEffect.acquireRelease(startManagedExecEffect(input), (started) =>
    BrewvaEffect.sync(() => {
      if (!started.session.backgrounded && !started.session.exited) {
        terminateRunningSession(started.session, true);
      }
    }),
  );
}

export function terminateRunningSessionEffect(
  session: ManagedExecRunningSession,
  force = false,
): BrewvaEffect.Effect<boolean> {
  return BrewvaEffect.sync(() => terminateRunningSession(session, force));
}
