import {
  type BrewvaBoundaryFailure,
  BrewvaDuration,
  BrewvaEffect,
  BrewvaSessionScope,
  addScopedFinalizer,
  runPromiseAtBoundary,
  withBrewvaObservability,
} from "@brewva/brewva-effect";
import {
  deleteManagedSession,
  markSessionBackgrounded,
  scopedManagedExec,
  terminateRunningSession,
  type ManagedExecFinishedSession,
  type ManagedExecRunningSession,
} from "../exec-process-registry.js";
import { textResult, withVerdict } from "../utils/result.js";
import { execDisplayResult, isSafeEnvKey } from "./shared.js";
import { ExecCommandFailedError } from "./shared.js";

type HostCommandResult = ReturnType<typeof textResult>;

function formatExit(session: ManagedExecFinishedSession): string {
  if (session.exitSignal) return `signal ${session.exitSignal}`;
  return `code ${session.exitCode ?? 0}`;
}

function runningResult(session: ManagedExecRunningSession) {
  const lines = [
    `Command still running (session ${session.id}, pid ${session.pid ?? "n/a"}).`,
    "Use process (list/poll/log/write/kill/clear/remove) for follow-up.",
  ];
  if (session.tail.trim().length > 0) {
    lines.push("", session.tail.trimEnd());
  }
  return execDisplayResult(lines.join("\n"), {
    status: "running",
    verdict: "inconclusive",
    sessionId: session.id,
    pid: session.pid ?? undefined,
    startedAt: session.startedAt,
    cwd: session.cwd,
    tail: session.tail,
    command: session.command,
    backend: "host",
  });
}

function waitForCompletionOrYieldEffect(
  completion: Promise<ManagedExecFinishedSession>,
  yieldMs: number,
): BrewvaEffect.Effect<ManagedExecFinishedSession | undefined> {
  if (yieldMs === 0) {
    return BrewvaEffect.succeed(undefined);
  }
  return BrewvaEffect.race(
    BrewvaEffect.promise(() => completion),
    BrewvaEffect.sleep(BrewvaDuration.millis(yieldMs)).pipe(BrewvaEffect.as(undefined)),
  );
}

export function buildHostEnv(requestedEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(process.env)) {
    if (isSafeEnvKey(key) && typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(requestedEnv ?? {})) {
    if (isSafeEnvKey(key)) {
      env[key] = value;
    }
  }
  return env;
}

export interface ExecuteHostCommandInput {
  ownerSessionId: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec?: number;
  background: boolean;
  yieldMs: number;
  signal?: AbortSignal;
}

export function executeHostCommandEffect(
  input: ExecuteHostCommandInput,
): BrewvaEffect.Effect<HostCommandResult, BrewvaBoundaryFailure | ExecCommandFailedError> {
  const observability = {
    sessionId: input.ownerSessionId,
    backend: "host",
  };
  let startedForAbort: { session: ManagedExecRunningSession } | undefined;
  const onAbort = () => {
    const started = startedForAbort;
    if (!started || input.background || started.session.backgrounded) return;
    terminateRunningSession(started.session, true);
  };

  const program = BrewvaEffect.scoped(
    BrewvaEffect.gen(function* () {
      const startedResult = yield* scopedManagedExec({
        ownerSessionId: input.ownerSessionId,
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
      }).pipe(
        BrewvaEffect.map((started) => ({ ok: true as const, started })),
        BrewvaEffect.catch((error) => BrewvaEffect.succeed({ ok: false as const, error })),
      );
      if (!startedResult.ok) {
        const message =
          startedResult.error instanceof Error
            ? startedResult.error.message
            : String(startedResult.error);
        return textResult(
          `Exec failed to start: ${message}`,
          withVerdict(
            {
              status: "failed",
              command: input.command,
              cwd: input.cwd,
              backend: "host",
            },
            "fail",
          ),
        );
      }

      const started = startedResult.started;
      startedForAbort = started;
      if (input.signal) {
        input.signal.addEventListener("abort", onAbort, { once: true });
        yield* addScopedFinalizer(() => input.signal?.removeEventListener("abort", onAbort));
      }
      if (input.signal?.aborted) {
        onAbort();
      }

      if (input.background || input.yieldMs === 0) {
        markSessionBackgrounded(input.ownerSessionId, started.session.id);
        return runningResult(started.session);
      }

      const finished = yield* waitForCompletionOrYieldEffect(started.completion, input.yieldMs);
      if (!finished) {
        markSessionBackgrounded(input.ownerSessionId, started.session.id);
        return runningResult(started.session);
      }

      if (!finished.backgrounded) {
        deleteManagedSession(input.ownerSessionId, finished.id);
      }

      const output = finished.aggregated.trimEnd() || "(no output)";
      if (finished.status === "completed") {
        return execDisplayResult(output, {
          status: "completed",
          exitCode: finished.exitCode ?? 0,
          durationMs: finished.endedAt - finished.startedAt,
          cwd: finished.cwd,
          command: finished.command,
          backend: "host",
        });
      }

      return yield* BrewvaEffect.fail(
        new ExecCommandFailedError(
          `${output}\n\nProcess exited with ${formatExit(finished)}.`,
          finished.exitCode ?? 1,
        ),
      );
    }),
  ).pipe(
    BrewvaEffect.provide(BrewvaSessionScope.layer({ sessionId: input.ownerSessionId })),
    withBrewvaObservability("brewva.tools.host.exec", observability),
  );

  return program;
}

export async function executeHostCommand(
  input: ExecuteHostCommandInput,
): Promise<HostCommandResult> {
  return await runPromiseAtBoundary(executeHostCommandEffect(input));
}
