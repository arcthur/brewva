import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { addMilliseconds, isBefore } from "date-fns";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import {
  errTextResult,
  inconclusiveTextResult,
  okTextResult,
  textResultForOutcome,
} from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";
import {
  drainSessionOutput,
  MAX_POLL_WAIT_MS,
  readSessionLog,
} from "./exec-process-registry/api.js";
import { resolveManagedExecProcessRegistryRuntime } from "./exec-process-registry/runtime.js";
import { executeDetachedBoxIdentityAction } from "./process/detached-box.js";
import {
  defaultTailHint,
  exitLabel,
  formatSessionLabel,
  normalizeOutputText,
  renderListLine,
  resolveProcessOutcomeKind,
} from "./process/render.js";
import {
  pickBoxExecutionIdentity,
  pickSessionId,
  ProcessSchema,
  resolvePollTimeoutMs,
  resolvePollUntil,
  type ProcessAction,
  type ProcessToolOptions,
} from "./process/schema.js";
import { writeToStdin } from "./process/stdin.js";

export function createProcessTool(options?: ProcessToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options?.runtime, "process");
  return define({
    name: "process",
    label: "Process",
    description:
      "Manage background exec sessions: list, poll output, inspect logs, write stdin, kill.",
    promptGuidelines: [
      "Action values are list, poll, log, write, kill, clear, and remove.",
      "Use poll for incremental output while a background session is running; use log for retained output snapshots.",
      "For build/test verification commands, poll with until=exit and a generous timeout: output is drained server-side and one call returns the final result.",
    ],
    parameters: ProcessSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const registry = resolveManagedExecProcessRegistryRuntime(runtime);
      const ownerSessionId = getSessionId(ctx);
      const action = params.action as ProcessAction;

      if (action === "list") {
        const running = (await registry.listRunningBackground(ownerSessionId)).map((session) => ({
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
        const finished = (await registry.listFinishedBackground(ownerSessionId)).map((session) => ({
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
        const runningBox = (await registry.listRunningBoxBackground(ownerSessionId)).map(
          (session) => ({
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
          }),
        );
        const finishedBox = (await registry.listFinishedBoxBackground(ownerSessionId)).map(
          (session) => ({
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
          }),
        );

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
        return okTextResult(lines.join("\n") || "No running or recent background sessions.", {
          status: "completed",
          sessions,
        });
      }

      const sessionId = pickSessionId(params);
      const boxIdentity = pickBoxExecutionIdentity(params);
      if (!sessionId && !boxIdentity) {
        return errTextResult("sessionId is required unless boxId and executionId are provided.", {
          status: "failed",
        });
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
        return errTextResult("sessionId is required for this action.", { status: "failed" });
      }

      if (action === "poll") {
        const until = resolvePollUntil(params);
        // An exit wait without an explicit timeout still has to actually
        // wait — the schema promises exit polls return only on exit or
        // deadline, so the default is the maximum bounded wait, never 0.
        const timeoutMs =
          until === "exit"
            ? resolvePollTimeoutMs(params) || MAX_POLL_WAIT_MS
            : resolvePollTimeoutMs(params);
        if (until === "exit") {
          // Fail fast before waiting: polling a foreground session is a
          // caller error, and a long exit wait must not consume its output.
          const preflight = await registry.getRunning(ownerSessionId, sessionId);
          if (preflight && !preflight.backgrounded) {
            return errTextResult(`Session ${sessionId} is not backgrounded.`, {
              status: "failed",
            });
          }
          // Single blocking wait; output stays in the session's server-clamped
          // buffer and is drained once below after exit (or deadline).
          await registry.waitExit(ownerSessionId, sessionId, timeoutMs);
        } else {
          await registry.waitActivity(ownerSessionId, sessionId, timeoutMs);
        }

        const running = await registry.getRunning(ownerSessionId, sessionId);
        if (running) {
          if (!running.backgrounded) {
            return errTextResult(`Session ${sessionId} is not backgrounded.`, {
              status: "failed",
            });
          }
          const output = normalizeOutputText(drainSessionOutput(running), "(no new output)");
          return inconclusiveTextResult(`${output}\n\nProcess still running.`, {
            status: "running",
            sessionId,
            pid: running.pid ?? undefined,
            name: formatSessionLabel(running.command),
          });
        }

        const runningBox = await registry.getRunningBox(ownerSessionId, sessionId);
        if (runningBox) {
          const output = normalizeOutputText(drainSessionOutput(runningBox), "(no new output)");
          return inconclusiveTextResult(`${output}\n\nProcess still running.`, {
            status: "running",
            sessionId,
            backend: "box",
            boxId: runningBox.boxId,
            executionId: runningBox.executionId,
            name: formatSessionLabel(runningBox.command),
          });
        }

        const finished = await registry.getFinished(ownerSessionId, sessionId);
        const finishedBox = finished
          ? undefined
          : await registry.getFinishedBox(ownerSessionId, sessionId);
        const finishedSession = finished ?? finishedBox;
        if (!finishedSession) {
          return errTextResult(`No session found for ${sessionId}`, { status: "failed" });
        }

        const output = normalizeOutputText(drainSessionOutput(finishedSession), "(no new output)");
        return textResultForOutcome(
          resolveProcessOutcomeKind(finishedSession.status),
          `${output}\n\nProcess exited with ${exitLabel(finishedSession)}.`,
          {
            status: finishedSession.status,
            sessionId,
            backend: finishedBox ? "box" : "host",
            exitCode: finishedSession.exitCode ?? undefined,
            exitSignal: finishedSession.exitSignal ?? undefined,
            name: formatSessionLabel(finishedSession.command),
          },
        );
      }

      if (action === "log") {
        const running = await registry.getRunning(ownerSessionId, sessionId);
        const runningBox = running
          ? undefined
          : await registry.getRunningBox(ownerSessionId, sessionId);
        const finished =
          running || runningBox ? undefined : await registry.getFinished(ownerSessionId, sessionId);
        const finishedBox =
          running || runningBox || finished
            ? undefined
            : await registry.getFinishedBox(ownerSessionId, sessionId);
        const session = running ?? runningBox ?? finished ?? finishedBox;
        if (!session) {
          return errTextResult(`No session found for ${sessionId}`, { status: "failed" });
        }
        if (!session.backgrounded) {
          return errTextResult(`Session ${sessionId} is not backgrounded.`, {
            status: "failed",
          });
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
        return textResultForOutcome(
          resolveProcessOutcomeKind(status),
          content + defaultTailHint(log.totalLines, log.usingDefaultTail),
          {
            status,
            sessionId,
            totalLines: log.totalLines,
            totalChars: log.totalChars,
            truncated: session.truncated,
            name: formatSessionLabel(session.command),
          },
        );
      }

      if (action === "write") {
        const running = await registry.getRunning(ownerSessionId, sessionId);
        const runningBox = running
          ? undefined
          : await registry.getRunningBox(ownerSessionId, sessionId);
        if (runningBox) {
          return errTextResult(
            `Session ${sessionId} is a box execution; stdin reattach is not supported.`,
            { status: "failed", backend: "box" },
          );
        }
        if (!running) {
          return errTextResult(`No active session found for ${sessionId}`, { status: "failed" });
        }
        if (!running.backgrounded) {
          return errTextResult(`Session ${sessionId} is not backgrounded.`, {
            status: "failed",
          });
        }
        if (!running.stdin || running.stdin.destroyed) {
          return errTextResult(`Session ${sessionId} stdin is not writable.`, {
            status: "failed",
          });
        }

        const data = typeof params.data === "string" ? params.data : "";
        try {
          await writeToStdin(running, data, params.eof === true);
          return inconclusiveTextResult(
            `Wrote ${data.length} bytes to session ${sessionId}${params.eof ? " (stdin closed)" : ""}.`,
            {
              status: "running",
              sessionId,
              name: formatSessionLabel(running.command),
            },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return errTextResult(`Failed to write to session ${sessionId}: ${message}`, {
            status: "failed",
          });
        }
      }

      if (action === "kill") {
        const running = await registry.getRunning(ownerSessionId, sessionId);
        const runningBox = running
          ? undefined
          : await registry.getRunningBox(ownerSessionId, sessionId);
        if (!running && !runningBox) {
          return errTextResult(`No active session found for ${sessionId}`, { status: "failed" });
        }
        if (running && !running.backgrounded) {
          return errTextResult(`Session ${sessionId} is not backgrounded.`, {
            status: "failed",
          });
        }

        const terminated = running
          ? await registry.terminateHost(running, true)
          : await registry.terminateBox(runningBox!, true);
        const killedSession = running ?? runningBox!;
        if (!terminated) {
          return errTextResult(
            `Unable to terminate session ${sessionId}: no active process id or handle.`,
            { status: "failed" },
          );
        }
        return errTextResult(`Termination requested for session ${sessionId}.`, {
          status: "failed",
          sessionId,
          backend: runningBox ? "box" : "host",
          name: formatSessionLabel(killedSession.command),
        });
      }

      if (action === "clear") {
        const finished = await registry.getFinished(ownerSessionId, sessionId);
        const finishedBox = finished
          ? undefined
          : await registry.getFinishedBox(ownerSessionId, sessionId);
        if (!finished && !finishedBox) {
          return errTextResult(`No finished session found for ${sessionId}`, {
            status: "failed",
          });
        }
        await registry.delete(ownerSessionId, sessionId);
        return okTextResult(`Cleared session ${sessionId}.`, { status: "completed" });
      }

      if (action === "remove") {
        const running = await registry.getRunning(ownerSessionId, sessionId);
        const runningBox = running
          ? undefined
          : await registry.getRunningBox(ownerSessionId, sessionId);
        if (running) {
          await registry.terminateHost(running, true);
          const deadline = addMilliseconds(Date.now(), 3_000).getTime();
          while (!running.exited && isBefore(Date.now(), deadline)) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!running.exited) {
            return errTextResult(
              `Session ${sessionId} did not exit after termination. Use kill then try remove again.`,
              { status: "failed" },
            );
          }
        }
        if (runningBox) {
          await registry.terminateBox(runningBox, true);
          const deadline = addMilliseconds(Date.now(), 3_000).getTime();
          while (!runningBox.exited && isBefore(Date.now(), deadline)) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!runningBox.exited) {
            return errTextResult(
              `Session ${sessionId} did not exit after termination. Use kill then try remove again.`,
              { status: "failed" },
            );
          }
        }
        const removed = await registry.delete(ownerSessionId, sessionId);
        if (!removed) {
          return errTextResult(`No session found for ${sessionId}`, { status: "failed" });
        }
        const status = running || runningBox ? "failed" : "completed";
        return textResultForOutcome(
          resolveProcessOutcomeKind(status),
          `Removed session ${sessionId}.`,
          {
            status,
          },
        );
      }

      return errTextResult(`Unknown action: ${String(action)}`, { status: "failed" });
    },
  });
}
