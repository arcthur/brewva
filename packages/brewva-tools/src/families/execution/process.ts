import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { addMilliseconds, isBefore } from "date-fns";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { textResult, withVerdict } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";
import { drainSessionOutput, readSessionLog } from "./exec-process-registry/api.js";
import { resolveManagedExecProcessRegistryRuntime } from "./exec-process-registry/runtime.js";
import { executeDetachedBoxIdentityAction } from "./process/detached-box.js";
import {
  defaultTailHint,
  exitLabel,
  formatSessionLabel,
  normalizeOutputText,
  renderListLine,
  resolveProcessVerdict,
} from "./process/render.js";
import {
  pickBoxExecutionIdentity,
  pickSessionId,
  ProcessSchema,
  resolvePollTimeoutMs,
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
        await registry.waitActivity(ownerSessionId, sessionId, timeoutMs);

        const running = await registry.getRunning(ownerSessionId, sessionId);
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

        const runningBox = await registry.getRunningBox(ownerSessionId, sessionId);
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

        const finished = await registry.getFinished(ownerSessionId, sessionId);
        const finishedBox = finished
          ? undefined
          : await registry.getFinishedBox(ownerSessionId, sessionId);
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
        const running = await registry.getRunning(ownerSessionId, sessionId);
        const runningBox = running
          ? undefined
          : await registry.getRunningBox(ownerSessionId, sessionId);
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
        const running = await registry.getRunning(ownerSessionId, sessionId);
        const runningBox = running
          ? undefined
          : await registry.getRunningBox(ownerSessionId, sessionId);
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
          ? await registry.terminateHost(running, true)
          : await registry.terminateBox(runningBox!, true);
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
        const finished = await registry.getFinished(ownerSessionId, sessionId);
        const finishedBox = finished
          ? undefined
          : await registry.getFinishedBox(ownerSessionId, sessionId);
        if (!finished && !finishedBox) {
          return textResult(
            `No finished session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        await registry.delete(ownerSessionId, sessionId);
        return textResult(`Cleared session ${sessionId}.`, { status: "completed" });
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
            return textResult(
              `Session ${sessionId} did not exit after termination. Use kill then try remove again.`,
              withVerdict({ status: "failed" }, "fail"),
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
            return textResult(
              `Session ${sessionId} did not exit after termination. Use kill then try remove again.`,
              withVerdict({ status: "failed" }, "fail"),
            );
          }
        }
        const removed = await registry.delete(ownerSessionId, sessionId);
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
