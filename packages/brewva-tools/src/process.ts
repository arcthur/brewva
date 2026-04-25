import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import { addMilliseconds, differenceInMilliseconds, isBefore } from "date-fns";
import { resolveConfiguredBoxPlane, resolveRuntimeBoxConfig } from "./box-plane-runtime.js";
import {
  DEFAULT_LOG_TAIL_LINES,
  MAX_POLL_WAIT_MS,
  deleteManagedSession,
  drainSessionOutput,
  getFinishedBoxSession,
  getFinishedSession,
  getRunningBoxSession,
  getRunningSession,
  hasPendingOutput,
  listFinishedBoxBackgroundSessions,
  listFinishedBackgroundSessions,
  listRunningBoxBackgroundSessions,
  listRunningBackgroundSessions,
  readSessionLog,
  terminateRunningBoxSession,
  terminateRunningSession,
  type ManagedBoxExecFinishedSession,
  type ManagedExecFinishedSession,
  type ManagedExecRunningSession,
} from "./exec-process-registry.js";
import type { BrewvaBundledToolRuntime } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { textResult, type ToolResultVerdict, withVerdict } from "./utils/result.js";
import { createManagedBrewvaToolFactory } from "./utils/runtime-bound-tool.js";
import { getSessionId } from "./utils/session.js";

const PROCESS_ACTION_VALUES = ["list", "poll", "log", "write", "kill", "clear", "remove"] as const;
type ProcessAction = (typeof PROCESS_ACTION_VALUES)[number];
const ProcessActionSchema = buildStringEnumSchema(PROCESS_ACTION_VALUES, {
  guidance:
    "Use list to inspect sessions, poll for incremental output, log for stored logs, write for stdin, kill to stop a running session, clear to prune completed sessions, and remove to delete a stored session record.",
});

const ProcessSchema = Type.Object({
  action: ProcessActionSchema,
  sessionId: Type.Optional(Type.String()),
  boxId: Type.Optional(Type.String()),
  executionId: Type.Optional(Type.String()),
  data: Type.Optional(Type.String()),
  eof: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 0 })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_POLL_WAIT_MS })),
});

interface ProcessToolOptions {
  runtime?: BrewvaBundledToolRuntime;
}

function pickSessionId(params: { sessionId?: unknown }): string | undefined {
  const candidate = params.sessionId;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickBoxExecutionIdentity(params: {
  boxId?: unknown;
  executionId?: unknown;
}): { boxId: string; executionId: string } | undefined {
  if (typeof params.boxId !== "string" || typeof params.executionId !== "string") return undefined;
  const boxId = params.boxId.trim();
  const executionId = params.executionId.trim();
  if (!boxId || !executionId) return undefined;
  return { boxId, executionId };
}

function resolvePollTimeoutMs(params: { timeout?: unknown }): number {
  const raw = params.timeout;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.trunc(raw)));
}

function formatRuntimeMs(startedAt: number, endedAt = Date.now()): string {
  const value = Math.max(0, differenceInMilliseconds(endedAt, startedAt));
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatSessionLabel(command: string): string {
  const trimmed = command.trim().replaceAll(/\s+/g, " ");
  if (trimmed.length <= 96) return trimmed;
  return `${trimmed.slice(0, 93)}...`;
}

function renderListLine(input: {
  sessionId: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  command: string;
}): string {
  return `${input.sessionId} ${input.status.padEnd(9, " ")} ${formatRuntimeMs(
    input.startedAt,
    input.endedAt,
  )} :: ${formatSessionLabel(input.command)}`;
}

function normalizeOutputText(value: string, fallback: string): string {
  const text = value.trimEnd();
  return text.length > 0 ? text : fallback;
}

function exitLabel(session: ManagedExecFinishedSession | ManagedBoxExecFinishedSession): string {
  if (session.exitSignal) return `signal ${session.exitSignal}`;
  return `code ${session.exitCode ?? 0}`;
}

async function writeToStdin(
  session: ManagedExecRunningSession,
  data: string,
  eof: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    session.stdin.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (eof) {
    session.stdin.end();
  }
}

async function waitForPollCondition(
  ownerSessionId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return;
  const deadline = addMilliseconds(Date.now(), timeoutMs).getTime();
  while (isBefore(Date.now(), deadline)) {
    const running = getRunningSession(ownerSessionId, sessionId);
    const runningBox = getRunningBoxSession(ownerSessionId, sessionId);
    if (!running && !runningBox) return;
    if (running && (running.exited || hasPendingOutput(running))) return;
    if (runningBox && (runningBox.exited || hasPendingOutput(runningBox))) return;
    const sleepMs = Math.min(200, Math.max(1, differenceInMilliseconds(deadline, Date.now())));
    await new Promise((resolveNow) => setTimeout(resolveNow, sleepMs));
  }
}

function defaultTailHint(totalLines: number, usingDefaultTail: boolean): string {
  if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) return "";
  return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}

function resolveProcessVerdict(
  status: "running" | "completed" | "failed",
): ToolResultVerdict | undefined {
  if (status === "running") return "inconclusive";
  if (status === "failed") return "fail";
  return undefined;
}

async function executeDetachedBoxIdentityAction(input: {
  action: ProcessAction;
  boxId: string;
  executionId: string;
  timeoutMs: number;
  offset?: number;
  limit?: number;
  runtime?: BrewvaBundledToolRuntime;
}) {
  if (!["poll", "log", "kill"].includes(input.action)) {
    return textResult(
      `Action ${input.action} requires a managed sessionId.`,
      withVerdict({ status: "failed", backend: "box" }, "fail"),
    );
  }

  const boxConfig = resolveRuntimeBoxConfig(input.runtime);
  const plane = resolveConfiguredBoxPlane(input.runtime, boxConfig);

  if (input.action === "kill") {
    const execution = await plane.reattach(input.boxId, input.executionId);
    if (!execution) {
      return textResult(
        `No detached box execution found for ${input.boxId}/${input.executionId}`,
        withVerdict({ status: "failed", backend: "box" }, "fail"),
      );
    }
    await execution.kill("SIGKILL");
    return textResult(
      `Termination requested for box execution ${input.executionId}.`,
      withVerdict(
        {
          status: "failed",
          backend: "box",
          boxId: input.boxId,
          executionId: input.executionId,
          reattached: true,
        },
        "fail",
      ),
    );
  }

  let observation = await observeDetachedBoxExecution({
    plane,
    boxId: input.boxId,
    executionId: input.executionId,
    timeoutMs: input.action === "poll" ? input.timeoutMs : 0,
  });
  if (!observation) {
    return textResult(
      `No detached box execution found for ${input.boxId}/${input.executionId}`,
      withVerdict({ status: "failed", backend: "box" }, "fail"),
    );
  }

  const output = [observation.stdout, observation.stderr]
    .filter((part) => part.length > 0)
    .join("\n");
  const content =
    input.action === "log"
      ? readDetachedLog(output, input.offset, input.limit)
      : normalizeOutputText(output, "(no output yet)");
  const suffix =
    observation.status === "running"
      ? "\n\nProcess still running."
      : `\n\nProcess exited with code ${observation.exitCode ?? 0}.`;

  return textResult(
    input.action === "poll" ? `${content}${suffix}` : content,
    withVerdict(
      {
        status: observation.status,
        backend: "box",
        boxId: input.boxId,
        executionId: input.executionId,
        exitCode: observation.exitCode,
        reattached: true,
      },
      resolveProcessVerdict(observation.status),
    ),
  );
}

async function observeDetachedBoxExecution(input: {
  plane: ReturnType<typeof resolveConfiguredBoxPlane>;
  boxId: string;
  executionId: string;
  timeoutMs: number;
}) {
  const deadline = addMilliseconds(Date.now(), input.timeoutMs).getTime();
  let stdoutOffset = 0;
  let stderrOffset = 0;
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let latestObservation = await input.plane.observeExecution(input.boxId, input.executionId, {
    stdoutOffset,
    stderrOffset,
  });

  while (latestObservation) {
    if (latestObservation.stdout.length > 0) stdoutParts.push(latestObservation.stdout);
    if (latestObservation.stderr.length > 0) stderrParts.push(latestObservation.stderr);
    stdoutOffset = latestObservation.stdoutOffset;
    stderrOffset = latestObservation.stderrOffset;

    const hasBufferedOutput =
      latestObservation.stdoutTruncated === true || latestObservation.stderrTruncated === true;
    const shouldPollRunning =
      latestObservation.status === "running" &&
      input.timeoutMs > 0 &&
      isBefore(Date.now(), deadline);
    if (!hasBufferedOutput && !shouldPollRunning) break;

    const sleepMs = Math.min(200, Math.max(1, differenceInMilliseconds(deadline, Date.now())));
    if (!hasBufferedOutput && sleepMs > 0) {
      await new Promise((resolveNow) => setTimeout(resolveNow, sleepMs));
    }
    latestObservation = await input.plane.observeExecution(input.boxId, input.executionId, {
      stdoutOffset,
      stderrOffset,
    });
  }

  if (!latestObservation) return undefined;
  return {
    ...latestObservation,
    stdout: stdoutParts.join(""),
    stderr: stderrParts.join(""),
    stdoutOffset,
    stderrOffset,
  };
}

function readDetachedLog(output: string, offset?: number, limit?: number): string {
  const normalized = output.replaceAll("\r\n", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const safeOffset =
    typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : lines.length;
  return normalizeOutputText(
    lines.slice(safeOffset, safeOffset + safeLimit).join("\n"),
    "(no output recorded)",
  );
}

export function createProcessTool(options?: ProcessToolOptions): ToolDefinition {
  const processTool = createManagedBrewvaToolFactory("process");
  const runtime = options?.runtime;
  return processTool.define({
    name: "process",
    label: "Process",
    description:
      "Manage background exec sessions: list, poll output, inspect logs, write stdin, kill.",
    promptGuidelines: [
      "Action values are list, poll, log, write, kill, clear, and remove.",
      "Use poll for incremental output while a background session is running; use log for retained output snapshots.",
    ],
    parameters: ProcessSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ownerSessionId = getSessionId(ctx);
      const action = params.action as ProcessAction;

      if (action === "list") {
        const running = listRunningBackgroundSessions(ownerSessionId).map((session) => ({
          sessionId: session.id,
          status: "running",
          backend: "host",
          pid: session.pid ?? undefined,
          startedAt: session.startedAt,
          command: session.command,
          cwd: session.cwd,
          tail: session.tail,
          truncated: session.truncated,
        }));
        const finished = listFinishedBackgroundSessions(ownerSessionId).map((session) => ({
          sessionId: session.id,
          status: session.status,
          backend: "host",
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          command: session.command,
          cwd: session.cwd,
          exitCode: session.exitCode ?? undefined,
          exitSignal: session.exitSignal ?? undefined,
          tail: session.tail,
          truncated: session.truncated,
        }));
        const runningBox = listRunningBoxBackgroundSessions(ownerSessionId).map((session) => ({
          sessionId: session.id,
          status: "running",
          backend: "box",
          boxId: session.boxId,
          executionId: session.executionId,
          fingerprint: session.fingerprint,
          startedAt: session.startedAt,
          command: session.command,
          cwd: session.cwd,
          tail: session.tail,
          truncated: session.truncated,
        }));
        const finishedBox = listFinishedBoxBackgroundSessions(ownerSessionId).map((session) => ({
          sessionId: session.id,
          status: session.status,
          backend: "box",
          boxId: session.boxId,
          executionId: session.executionId,
          fingerprint: session.fingerprint,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          command: session.command,
          cwd: session.cwd,
          exitCode: session.exitCode ?? undefined,
          tail: session.tail,
          truncated: session.truncated,
        }));

        const sessions = [...running, ...finished, ...runningBox, ...finishedBox];
        const lines = sessions
          .toSorted((left, right) => right.startedAt - left.startedAt)
          .map((session) =>
            renderListLine({
              sessionId: session.sessionId,
              status: session.status,
              startedAt: session.startedAt,
              endedAt: "endedAt" in session ? session.endedAt : undefined,
              command: session.command,
            }),
          );
        return textResult(lines.join("\n") || "No running or recent background sessions.", {
          status: "completed",
          sessions,
        });
      }

      const sessionId = pickSessionId(params);
      const boxIdentity = pickBoxExecutionIdentity(params);
      if (!sessionId && !boxIdentity) {
        return textResult(
          "sessionId is required unless boxId and executionId are provided.",
          withVerdict({ status: "failed" }, "fail"),
        );
      }
      if (!sessionId && boxIdentity) {
        return await executeDetachedBoxIdentityAction({
          action,
          boxId: boxIdentity.boxId,
          executionId: boxIdentity.executionId,
          timeoutMs: resolvePollTimeoutMs(params),
          offset: params.offset,
          limit: params.limit,
          runtime,
        });
      }
      if (!sessionId) {
        return textResult(
          "sessionId is required for this action.",
          withVerdict({ status: "failed" }, "fail"),
        );
      }

      if (action === "poll") {
        const timeoutMs = resolvePollTimeoutMs(params);
        await waitForPollCondition(ownerSessionId, sessionId, timeoutMs);

        const running = getRunningSession(ownerSessionId, sessionId);
        if (running) {
          if (!running.backgrounded) {
            return textResult(
              `Session ${sessionId} is not backgrounded.`,
              withVerdict({ status: "failed" }, "fail"),
            );
          }
          const output = normalizeOutputText(drainSessionOutput(running), "(no new output)");
          return textResult(
            `${output}\n\nProcess still running.`,
            withVerdict(
              {
                status: "running",
                sessionId,
                pid: running.pid ?? undefined,
                name: formatSessionLabel(running.command),
              },
              "inconclusive",
            ),
          );
        }

        const runningBox = getRunningBoxSession(ownerSessionId, sessionId);
        if (runningBox) {
          const output = normalizeOutputText(drainSessionOutput(runningBox), "(no new output)");
          return textResult(
            `${output}\n\nProcess still running.`,
            withVerdict(
              {
                status: "running",
                sessionId,
                backend: "box",
                boxId: runningBox.boxId,
                executionId: runningBox.executionId,
                name: formatSessionLabel(runningBox.command),
              },
              "inconclusive",
            ),
          );
        }

        const finished = getFinishedSession(ownerSessionId, sessionId);
        const finishedBox = finished ? undefined : getFinishedBoxSession(ownerSessionId, sessionId);
        const finishedSession = finished ?? finishedBox;
        if (!finishedSession) {
          return textResult(
            `No session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const output = normalizeOutputText(drainSessionOutput(finishedSession), "(no new output)");
        return textResult(
          `${output}\n\nProcess exited with ${exitLabel(finishedSession)}.`,
          withVerdict(
            {
              status: finishedSession.status,
              sessionId,
              backend: finishedBox ? "box" : "host",
              exitCode: finishedSession.exitCode ?? undefined,
              exitSignal: finishedSession.exitSignal ?? undefined,
              name: formatSessionLabel(finishedSession.command),
            },
            resolveProcessVerdict(finishedSession.status),
          ),
        );
      }

      if (action === "log") {
        const running = getRunningSession(ownerSessionId, sessionId);
        const runningBox = running ? undefined : getRunningBoxSession(ownerSessionId, sessionId);
        const finished =
          running || runningBox ? undefined : getFinishedSession(ownerSessionId, sessionId);
        const finishedBox =
          running || runningBox || finished
            ? undefined
            : getFinishedBoxSession(ownerSessionId, sessionId);
        const session = running ?? runningBox ?? finished ?? finishedBox;
        if (!session) {
          return textResult(
            `No session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        if (!session.backgrounded) {
          return textResult(
            `Session ${sessionId} is not backgrounded.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const log = readSessionLog(session, params.offset, params.limit);
        const content = normalizeOutputText(
          log.output,
          running || runningBox ? "(no output yet)" : "(no output recorded)",
        );
        const status =
          running || runningBox
            ? "running"
            : (finished?.status ?? finishedBox?.status ?? "completed");
        return textResult(
          content + defaultTailHint(log.totalLines, log.usingDefaultTail),
          withVerdict(
            {
              status,
              sessionId,
              totalLines: log.totalLines,
              totalChars: log.totalChars,
              truncated: session.truncated,
              name: formatSessionLabel(session.command),
            },
            resolveProcessVerdict(status),
          ),
        );
      }

      if (action === "write") {
        const running = getRunningSession(ownerSessionId, sessionId);
        const runningBox = running ? undefined : getRunningBoxSession(ownerSessionId, sessionId);
        if (runningBox) {
          return textResult(
            `Session ${sessionId} is a box execution; stdin reattach is not supported.`,
            withVerdict({ status: "failed", backend: "box" }, "fail"),
          );
        }
        if (!running) {
          return textResult(
            `No active session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        if (!running.backgrounded) {
          return textResult(
            `Session ${sessionId} is not backgrounded.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        if (!running.stdin || running.stdin.destroyed) {
          return textResult(
            `Session ${sessionId} stdin is not writable.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const data = typeof params.data === "string" ? params.data : "";
        try {
          await writeToStdin(running, data, params.eof === true);
          return textResult(
            `Wrote ${data.length} bytes to session ${sessionId}${params.eof ? " (stdin closed)" : ""}.`,
            withVerdict(
              {
                status: "running",
                sessionId,
                name: formatSessionLabel(running.command),
              },
              "inconclusive",
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(
            `Failed to write to session ${sessionId}: ${message}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
      }

      if (action === "kill") {
        const running = getRunningSession(ownerSessionId, sessionId);
        const runningBox = running ? undefined : getRunningBoxSession(ownerSessionId, sessionId);
        if (!running && !runningBox) {
          return textResult(
            `No active session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        if (running && !running.backgrounded) {
          return textResult(
            `Session ${sessionId} is not backgrounded.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const terminated = running
          ? terminateRunningSession(running, true)
          : await terminateRunningBoxSession(runningBox!, true);
        const killedSession = running ?? runningBox!;
        if (!terminated) {
          return textResult(
            `Unable to terminate session ${sessionId}: no active process id or handle.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        return textResult(
          `Termination requested for session ${sessionId}.`,
          withVerdict(
            {
              status: "failed",
              sessionId,
              backend: runningBox ? "box" : "host",
              name: formatSessionLabel(killedSession.command),
            },
            "fail",
          ),
        );
      }

      if (action === "clear") {
        const finished = getFinishedSession(ownerSessionId, sessionId);
        const finishedBox = finished ? undefined : getFinishedBoxSession(ownerSessionId, sessionId);
        if (!finished && !finishedBox) {
          return textResult(
            `No finished session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        deleteManagedSession(ownerSessionId, sessionId);
        return textResult(`Cleared session ${sessionId}.`, { status: "completed" });
      }

      if (action === "remove") {
        const running = getRunningSession(ownerSessionId, sessionId);
        const runningBox = running ? undefined : getRunningBoxSession(ownerSessionId, sessionId);
        if (running) {
          terminateRunningSession(running, true);
          const deadline = addMilliseconds(Date.now(), 3_000).getTime();
          while (!running.exited && isBefore(Date.now(), deadline)) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!running.exited) {
            return textResult(
              `Session ${sessionId} did not exit after termination. Use kill then try remove again.`,
              withVerdict({ status: "failed" }, "fail"),
            );
          }
        }
        if (runningBox) {
          await terminateRunningBoxSession(runningBox, true);
          const deadline = addMilliseconds(Date.now(), 3_000).getTime();
          while (!runningBox.exited && isBefore(Date.now(), deadline)) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!runningBox.exited) {
            return textResult(
              `Session ${sessionId} did not exit after termination. Use kill then try remove again.`,
              withVerdict({ status: "failed" }, "fail"),
            );
          }
        }
        const removed = deleteManagedSession(ownerSessionId, sessionId);
        if (!removed) {
          return textResult(
            `No session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        const status = running || runningBox ? "failed" : "completed";
        return textResult(
          `Removed session ${sessionId}.`,
          withVerdict({ status }, resolveProcessVerdict(status)),
        );
      }

      return textResult(
        `Unknown action: ${String(action)}`,
        withVerdict({ status: "failed" }, "fail"),
      );
    },
  });
}
