import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { BoxExec, BoxPlane } from "@brewva/brewva-box";
import {
  BrewvaBoundaryFailure,
  BrewvaCause,
  BrewvaDeferred,
  BrewvaDuration,
  BrewvaEffect,
  BrewvaQueue,
  BrewvaStream,
  addScopedFinalizer,
  runPromiseAtBoundary,
  startScopedTimeout,
  type ScopedTimeoutHandle,
  type BrewvaScope,
} from "@brewva/brewva-effect";
import { resolveShellConfig as getShellConfig } from "@brewva/brewva-substrate/host-api";
import { differenceInMilliseconds } from "date-fns";

const MAX_AGGREGATED_OUTPUT_CHARS = 1_000_000;
const TAIL_CHARS = 4_000;
const FINISHED_TTL_MS = 30 * 60 * 1000;
const BOX_OBSERVE_POLL_MS = 500;
const BOX_OBSERVE_MAX_BYTES = 64 * 1024;

export const DEFAULT_LOG_TAIL_LINES = 200;
export const MAX_POLL_WAIT_MS = 120_000;

export type ManagedExecResultStatus = "completed" | "failed";
export type ManagedExecBackend = "host" | "box";
export type ManagedExecOutputChannel = "stdout" | "stderr" | "system";

export type ManagedExecOutputEvent =
  | {
      type: "output";
      sessionId: string;
      ownerSessionId: string;
      backend: ManagedExecBackend;
      channel: ManagedExecOutputChannel;
      chunk: string;
      aggregateChars: number;
      truncated: boolean;
      emittedAt: number;
    }
  | {
      type: "exit";
      sessionId: string;
      ownerSessionId: string;
      backend: ManagedExecBackend;
      status: ManagedExecResultStatus;
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
      emittedAt: number;
    };

export class ManagedExecSessionNotFoundError extends Error {
  readonly _tag = "ManagedExecSessionNotFoundError";

  constructor(readonly sessionId: string) {
    super(`managed exec session not found: ${sessionId}`);
    this.name = "ManagedExecSessionNotFoundError";
  }
}

export type ManagedExecStartError = BrewvaBoundaryFailure;
export type ManagedExecRuntimeError = BrewvaBoundaryFailure | ManagedExecSessionNotFoundError;

interface ManagedExecBase {
  id: string;
  ownerSessionId: string;
  command: string;
  cwd: string;
  startedAt: number;
  pid: number | null;
  backgrounded: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  aggregated: string;
  tail: string;
  truncated: boolean;
  drainCursor: number;
  timedOut: boolean;
  removed: boolean;
}

interface ManagedOutputSession {
  id: string;
  ownerSessionId: string;
  kind: string;
  aggregated: string;
  tail: string;
  truncated: boolean;
  drainCursor: number;
  removed: boolean;
}

export interface ManagedExecRunningSession extends ManagedExecBase {
  kind: "running";
  child: ChildProcessWithoutNullStreams;
  stdin: ChildProcessWithoutNullStreams["stdin"];
  timeoutHandle?: ScopedTimeoutHandle;
}

export interface ManagedExecFinishedSession extends ManagedExecBase {
  kind: "finished";
  endedAt: number;
  status: ManagedExecResultStatus;
}

export interface ManagedBoxExecRunningSession extends ManagedExecBase {
  kind: "box_running";
  boxId: string;
  executionId: string;
  fingerprint?: string;
  execution: BoxExec;
  timeoutHandle?: ScopedTimeoutHandle;
}

export interface ManagedBoxExecFinishedSession extends ManagedExecBase {
  kind: "box_finished";
  boxId: string;
  executionId: string;
  fingerprint?: string;
  endedAt: number;
  status: ManagedExecResultStatus;
}

export interface ManagedExecStartInput {
  ownerSessionId: string;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutSec?: number;
}

export interface ManagedExecStartResult {
  session: ManagedExecRunningSession;
  completion: Promise<ManagedExecFinishedSession>;
}

export interface ManagedBoxExecStartInput {
  ownerSessionId: string;
  command: string;
  cwd: string;
  boxId: string;
  fingerprint?: string;
  execution: BoxExec;
  plane: BoxPlane;
  timeoutSec?: number;
  releaseOnCompletion?: () => Promise<void>;
}

export interface ManagedBoxExecStartResult {
  session: ManagedBoxExecRunningSession;
  completion: Promise<ManagedBoxExecFinishedSession>;
}

export interface SessionLogSlice {
  output: string;
  totalLines: number;
  totalChars: number;
  usingDefaultTail: boolean;
}

const runningSessions = new Map<string, ManagedExecRunningSession>();
const finishedSessions = new Map<string, ManagedExecFinishedSession>();
const runningBoxSessions = new Map<string, ManagedBoxExecRunningSession>();
const finishedBoxSessions = new Map<string, ManagedBoxExecFinishedSession>();
type ManagedOutputSubscriber = (
  event: ManagedExecOutputEvent,
) => void | boolean | Promise<void | boolean>;
const outputSubscribers = new Map<string, Set<ManagedOutputSubscriber>>();

function cleanupExpiredFinishedSessions(now = Date.now()): void {
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

function createSessionId(): string {
  return `proc_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

function clampNonNegativeInt(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function resolveBackend(session: Pick<ManagedOutputSession, "kind">): ManagedExecBackend {
  return session.kind.startsWith("box_") ? "box" : "host";
}

async function publishOutputEvent(event: ManagedExecOutputEvent): Promise<void> {
  const subscribers = outputSubscribers.get(event.sessionId);
  if (!subscribers || subscribers.size === 0) {
    return;
  }
  await Promise.all(
    [...subscribers].map(async (subscriber) => {
      try {
        const keep = await subscriber(event);
        if (keep === false) {
          subscribers.delete(subscriber);
        }
      } catch {
        subscribers.delete(subscriber);
      }
    }),
  );
  if (subscribers.size === 0) {
    outputSubscribers.delete(event.sessionId);
  }
}

function subscribeManagedSessionOutput(
  sessionId: string,
  subscriber: ManagedOutputSubscriber,
): () => void {
  const subscribers = outputSubscribers.get(sessionId) ?? new Set();
  subscribers.add(subscriber);
  outputSubscribers.set(sessionId, subscribers);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      outputSubscribers.delete(sessionId);
    }
  };
}

function appendOutputToSession(
  session: ManagedOutputSession,
  chunk: Buffer | string,
  channel: ManagedExecOutputChannel = "system",
): ManagedExecOutputEvent | undefined {
  if (session.removed) return undefined;
  const text = String(chunk);
  if (!text) return undefined;

  session.aggregated += text;
  if (session.aggregated.length > MAX_AGGREGATED_OUTPUT_CHARS) {
    const overflow = session.aggregated.length - MAX_AGGREGATED_OUTPUT_CHARS;
    session.aggregated = session.aggregated.slice(overflow);
    session.drainCursor = Math.max(0, session.drainCursor - overflow);
    session.truncated = true;
  }

  if (session.drainCursor > session.aggregated.length) {
    session.drainCursor = session.aggregated.length;
  }
  session.tail = session.aggregated.slice(-TAIL_CHARS);
  return {
    type: "output",
    sessionId: session.id,
    ownerSessionId: session.ownerSessionId,
    backend: resolveBackend(session),
    channel,
    chunk: text,
    aggregateChars: session.aggregated.length,
    truncated: session.truncated,
    emittedAt: Date.now(),
  };
}

function appendOutput(
  session: ManagedOutputSession,
  chunk: Buffer | string,
  channel: ManagedExecOutputChannel = "system",
): void {
  const event = appendOutputToSession(session, chunk, channel);
  if (!event) {
    return;
  }
  void publishOutputEvent(event);
}

async function appendOutputWithBackpressure(
  session: ManagedOutputSession,
  chunk: Buffer | string,
  channel: ManagedExecOutputChannel = "system",
): Promise<void> {
  const event = appendOutputToSession(session, chunk, channel);
  if (!event) {
    return;
  }
  await publishOutputEvent(event);
}

function sliceUtf8FromByteOffset(text: string, offset: number): string {
  if (offset <= 0) return text;
  const bytes = Buffer.from(text, "utf8");
  if (offset >= bytes.length) return "";
  return bytes.subarray(offset).toString("utf8");
}

function closeSessionTimeout(session: { timeoutHandle?: ScopedTimeoutHandle }): void {
  const timeoutHandle = session.timeoutHandle;
  if (!timeoutHandle) {
    return;
  }
  session.timeoutHandle = undefined;
  void timeoutHandle.close();
}

function finalizeBoxSession(
  session: ManagedBoxExecRunningSession,
  params: {
    exitCode: number | null;
    output?: string;
    timedOut?: boolean;
    error?: string;
  },
): ManagedBoxExecFinishedSession {
  closeSessionTimeout(session);
  runningBoxSessions.delete(session.id);
  if (params.output) {
    appendOutput(session, params.output, "system");
  }
  if (params.error) {
    appendOutput(session, `\n\n${params.error}`, "system");
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
    finishedBoxSessions.set(finished.id, finished);
    cleanupExpiredFinishedSessions();
  }
  void publishOutputEvent({
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

function finalizeSession(session: ManagedExecRunningSession): ManagedExecFinishedSession {
  closeSessionTimeout(session);
  runningSessions.delete(session.id);

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
    finishedSessions.set(finished.id, finished);
    cleanupExpiredFinishedSessions();
  }
  void publishOutputEvent({
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

export function startManagedBoxExec(input: ManagedBoxExecStartInput): ManagedBoxExecStartResult {
  cleanupExpiredFinishedSessions();

  const id = createSessionId();
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let outputAppendQueue: Promise<void> = Promise.resolve();
  let finalized: ManagedBoxExecFinishedSession | undefined;
  let releaseCompleted = false;
  let resolveCompletion: (session: ManagedBoxExecFinishedSession) => void = () => undefined;
  const session: ManagedBoxExecRunningSession = {
    id,
    kind: "box_running",
    ownerSessionId: input.ownerSessionId,
    command: input.command,
    cwd: input.cwd,
    startedAt: Date.now(),
    pid: null,
    boxId: input.boxId,
    executionId: input.execution.id,
    fingerprint: input.fingerprint,
    execution: input.execution,
    backgrounded: true,
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
  runningBoxSessions.set(session.id, session);

  const completion = new Promise<ManagedBoxExecFinishedSession>((resolveNow) => {
    resolveCompletion = resolveNow;
  });

  const observeCurrentOffsetsBestEffort = async (): Promise<void> => {
    try {
      await input.plane.observeExecution(input.boxId, input.execution.id, {
        stdoutOffset,
        stderrOffset,
        maxBytes: BOX_OBSERVE_MAX_BYTES,
      });
    } catch {
      // Best-effort reconciliation only.
    }
  };

  const finalizeOnce = (params: {
    exitCode: number | null;
    output?: string;
    timedOut?: boolean;
    error?: string;
  }): ManagedBoxExecFinishedSession => {
    if (finalized) return finalized;
    session.exited = true;
    finalized = finalizeBoxSession(session, params);
    if (!input.releaseOnCompletion) {
      releaseCompleted = true;
      resolveCompletion(finalized);
    }
    return finalized;
  };

  const releaseAfterCompletion = async (finished: ManagedBoxExecFinishedSession): Promise<void> => {
    if (releaseCompleted) {
      return;
    }
    releaseCompleted = true;
    if (input.releaseOnCompletion) {
      try {
        await input.releaseOnCompletion();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendOutput(finished, `\n\nBox release after execution failed: ${message}`, "system");
      }
    }
    resolveCompletion(finished);
  };

  const settle = async (
    params: {
      exitCode: number | null;
      output?: string;
      timedOut?: boolean;
      error?: string;
    },
    options?: { release?: boolean },
  ): Promise<ManagedBoxExecFinishedSession> => {
    const finished = finalizeOnce(params);
    if (options?.release === true) {
      await releaseAfterCompletion(finished);
    }
    return finished;
  };

  const appendObservedOutput = async (): Promise<boolean> => {
    let keepPolling = true;
    const appendTask = outputAppendQueue.then(
      async () => {
        if (finalized || session.exited || session.removed) {
          keepPolling = false;
          return;
        }
        try {
          const observation = await input.plane.observeExecution(input.boxId, input.execution.id, {
            stdoutOffset,
            stderrOffset,
            maxBytes: BOX_OBSERVE_MAX_BYTES,
          });
          if (!observation) {
            keepPolling = true;
            return;
          }
          stdoutOffset = observation.stdoutOffset;
          stderrOffset = observation.stderrOffset;
          const hasBufferedOutput =
            observation.stdoutTruncated === true || observation.stderrTruncated === true;
          keepPolling = observation.status === "running" || hasBufferedOutput;
          const outputEvents = [
            observation.stdout.length > 0
              ? appendOutputToSession(session, observation.stdout, "stdout")
              : undefined,
            observation.stderr.length > 0
              ? appendOutputToSession(session, observation.stderr, "stderr")
              : undefined,
          ].filter((event): event is ManagedExecOutputEvent => event !== undefined);
          const publishOutput = Promise.all(outputEvents.map((event) => publishOutputEvent(event)));
          if (
            !keepPolling &&
            typeof observation.exitCode === "number" &&
            observation.status !== "running"
          ) {
            await observeCurrentOffsetsBestEffort();
            await settle({
              exitCode: observation.exitCode,
            });
          }
          await publishOutput;
        } catch {
          keepPolling = true;
        }
      },
      async () => {
        keepPolling = true;
      },
    );
    outputAppendQueue = appendTask.then(
      () => undefined,
      () => undefined,
    );
    await appendTask;
    return keepPolling;
  };

  void (async () => {
    while (!session.exited && !session.removed) {
      const keepPolling = await appendObservedOutput();
      if (!keepPolling) break;
      await runPromiseAtBoundary(BrewvaEffect.sleep(BrewvaDuration.millis(BOX_OBSERVE_POLL_MS)));
    }
  })();

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
          void input.execution.kill("SIGKILL");
        }),
    });
  }

  input.execution
    .wait()
    .then(async (result) => {
      if (finalized) {
        await observeCurrentOffsetsBestEffort();
        await releaseAfterCompletion(finalized);
        return finalized;
      }
      await appendObservedOutput();
      if (finalized) {
        await observeCurrentOffsetsBestEffort();
        await releaseAfterCompletion(finalized);
        return finalized;
      }
      session.exitCode = result.exitCode;
      const remainingStdout = sliceUtf8FromByteOffset(result.stdout, stdoutOffset);
      const remainingStderr = sliceUtf8FromByteOffset(result.stderr, stderrOffset);
      return await settle(
        {
          exitCode: result.exitCode,
          output: [remainingStdout, remainingStderr].filter((part) => part.length > 0).join("\n"),
        },
        { release: true },
      );
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return await settle({ exitCode: 1, error: message }, { release: true });
    });

  return { session, completion };
}

export function startManagedBoxExecEffect(
  input: ManagedBoxExecStartInput,
): BrewvaEffect.Effect<ManagedBoxExecStartResult, ManagedExecStartError> {
  return BrewvaEffect.tryPromise({
    try: () => Promise.resolve(startManagedBoxExec(input)),
    catch: (error) =>
      error instanceof BrewvaBoundaryFailure
        ? error
        : new BrewvaBoundaryFailure({
            message: "managedBoxExec.start failed",
            cause: error,
          }),
  });
}

export function scopedManagedBoxExec(
  input: ManagedBoxExecStartInput,
): BrewvaEffect.Effect<ManagedBoxExecStartResult, ManagedExecStartError, BrewvaScope.Scope> {
  return BrewvaEffect.acquireRelease(startManagedBoxExecEffect(input), (started) =>
    BrewvaEffect.promise(async () => {
      if (!started.session.backgrounded && !started.session.exited) {
        await terminateRunningBoxSession(started.session, true);
      }
    }),
  );
}

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

type ManagedSession =
  | ManagedExecRunningSession
  | ManagedExecFinishedSession
  | ManagedBoxExecRunningSession
  | ManagedBoxExecFinishedSession;

function getManagedSession(ownerSessionId: string, sessionId: string): ManagedSession | undefined {
  return (
    getRunningSession(ownerSessionId, sessionId) ??
    getRunningBoxSession(ownerSessionId, sessionId) ??
    getFinishedSession(ownerSessionId, sessionId) ??
    getFinishedBoxSession(ownerSessionId, sessionId)
  );
}

function isManagedSessionRunning(session: ManagedSession | undefined): boolean {
  return session?.kind === "running" || session?.kind === "box_running";
}

function isManagedSessionFinished(
  session: ManagedSession,
): session is ManagedExecFinishedSession | ManagedBoxExecFinishedSession {
  return session.kind === "finished" || session.kind === "box_finished";
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

export function hasPendingOutput(
  session:
    | ManagedExecRunningSession
    | ManagedExecFinishedSession
    | ManagedBoxExecRunningSession
    | ManagedBoxExecFinishedSession,
): boolean {
  return session.aggregated.length > session.drainCursor;
}

export function drainSessionOutput(
  session:
    | ManagedExecRunningSession
    | ManagedExecFinishedSession
    | ManagedBoxExecRunningSession
    | ManagedBoxExecFinishedSession,
): string {
  if (session.drainCursor > session.aggregated.length) {
    session.drainCursor = session.aggregated.length;
  }
  const next = session.aggregated.slice(session.drainCursor);
  session.drainCursor = session.aggregated.length;
  return next;
}

export function readSessionLog(
  session:
    | ManagedExecRunningSession
    | ManagedExecFinishedSession
    | ManagedBoxExecRunningSession
    | ManagedBoxExecFinishedSession,
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

export async function terminateRunningBoxSession(
  session: ManagedBoxExecRunningSession,
  force = false,
): Promise<boolean> {
  if (session.exited) return false;
  try {
    await session.execution.kill(force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function terminateRunningSessionEffect(
  session: ManagedExecRunningSession,
  force = false,
): BrewvaEffect.Effect<boolean> {
  return BrewvaEffect.sync(() => terminateRunningSession(session, force));
}

export function terminateRunningBoxSessionEffect(
  session: ManagedBoxExecRunningSession,
  force = false,
): BrewvaEffect.Effect<boolean, BrewvaBoundaryFailure> {
  return BrewvaEffect.tryPromise({
    try: () => terminateRunningBoxSession(session, force),
    catch: (error) =>
      error instanceof BrewvaBoundaryFailure
        ? error
        : new BrewvaBoundaryFailure({
            message: "managedBoxExec.terminate failed",
            cause: error,
          }),
  });
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
