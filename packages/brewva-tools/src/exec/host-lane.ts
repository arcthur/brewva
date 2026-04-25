import {
  deleteManagedSession,
  markSessionBackgrounded,
  startManagedExec,
  terminateRunningSession,
  type ManagedExecFinishedSession,
  type ManagedExecRunningSession,
} from "../exec-process-registry.js";
import { textResult, withVerdict } from "../utils/result.js";
import { execDisplayResult, isSafeEnvKey } from "./shared.js";

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

async function waitForCompletionOrYield(
  completion: Promise<ManagedExecFinishedSession>,
  yieldMs: number,
): Promise<ManagedExecFinishedSession | undefined> {
  if (yieldMs === 0) return undefined;
  const timerTag = Symbol("yield");
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  const winner = await Promise.race([
    completion,
    new Promise<symbol>((resolveNow) => {
      yieldTimer = setTimeout(() => resolveNow(timerTag), yieldMs);
    }),
  ]);
  if (winner !== timerTag && yieldTimer !== undefined) {
    clearTimeout(yieldTimer);
  }
  if (winner === timerTag) return undefined;
  return winner as ManagedExecFinishedSession;
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

export async function executeHostCommand(input: {
  ownerSessionId: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec?: number;
  background: boolean;
  yieldMs: number;
  signal?: AbortSignal;
}) {
  let started;
  try {
    started = startManagedExec({
      ownerSessionId: input.ownerSessionId,
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

  const onAbort = () => {
    if (input.background || started.session.backgrounded) return;
    terminateRunningSession(started.session, true);
  };

  if (input.signal?.aborted) {
    onAbort();
  } else if (input.signal) {
    input.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    if (input.background || input.yieldMs === 0) {
      markSessionBackgrounded(input.ownerSessionId, started.session.id);
      return runningResult(started.session);
    }

    const finished = await waitForCompletionOrYield(started.completion, input.yieldMs);
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

    throw new Error(`${output}\n\nProcess exited with ${formatExit(finished)}.`);
  } finally {
    if (input.signal) {
      input.signal.removeEventListener("abort", onAbort);
    }
  }
}
