import { BrewvaBoundaryFailure, startBoundaryTimeout } from "@brewva/brewva-effect";
import { BrewvaEffect, type BrewvaScope } from "@brewva/brewva-effect/primitives";
import { finalizeBoxSession } from "./internal/lifecycle.js";
import {
  appendOutput,
  appendOutputToSession,
  publishOutputEvent,
  sliceUtf8FromByteOffset,
} from "./internal/output.js";
import {
  cleanupExpiredFinishedSessions,
  createSessionId,
  type ManagedExecProcessRegistryState,
} from "./internal/state.js";
import {
  BOX_OBSERVE_MAX_BYTES,
  BOX_OBSERVE_POLL_MS,
  type ManagedBoxExecFinishedSession,
  type ManagedBoxExecRunningSession,
  type ManagedBoxExecStartInput,
  type ManagedBoxExecStartResult,
  type ManagedExecOutputEvent,
  type ManagedExecStartError,
} from "./types.js";

export function startManagedBoxExec(
  registry: ManagedExecProcessRegistryState,
  input: ManagedBoxExecStartInput,
): ManagedBoxExecStartResult {
  cleanupExpiredFinishedSessions(registry);

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
  registry.runningBoxSessions.set(session.id, session);

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
    finalized = finalizeBoxSession(registry, session, params);
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
        appendOutput(
          registry,
          finished,
          `\n\nBox release after execution failed: ${message}`,
          "system",
        );
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
          const publishOutput = Promise.all(
            outputEvents.map((event) => publishOutputEvent(registry, event)),
          );
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
      await new Promise((resolveSleep) => setTimeout(resolveSleep, BOX_OBSERVE_POLL_MS));
    }
  })();

  if (typeof input.timeoutSec === "number" && input.timeoutSec > 0) {
    const timeoutMs = Math.trunc(input.timeoutSec * 1000);
    session.timeoutHandle = startBoundaryTimeout({
      delayMs: timeoutMs,
      run: () =>
        BrewvaEffect.sync(() => {
          if (session.exited || session.removed) return;
          session.timedOut = true;
          appendOutput(
            registry,
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
  registry: ManagedExecProcessRegistryState,
  input: ManagedBoxExecStartInput,
): BrewvaEffect.Effect<ManagedBoxExecStartResult, ManagedExecStartError> {
  return BrewvaEffect.tryPromise({
    try: () => Promise.resolve(startManagedBoxExec(registry, input)),
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
  registry: ManagedExecProcessRegistryState,
  input: ManagedBoxExecStartInput,
): BrewvaEffect.Effect<ManagedBoxExecStartResult, ManagedExecStartError, BrewvaScope.Scope> {
  return BrewvaEffect.acquireRelease(startManagedBoxExecEffect(registry, input), (started) =>
    BrewvaEffect.promise(async () => {
      if (!started.session.backgrounded && !started.session.exited) {
        await terminateRunningBoxSession(started.session, true);
      }
    }),
  );
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
