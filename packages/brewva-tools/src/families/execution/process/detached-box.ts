import { addMilliseconds, differenceInMilliseconds, isBefore } from "date-fns";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { errTextResult, textResultForOutcome } from "../../../utils/result.js";
import { resolveConfiguredBoxPlane, resolveRuntimeBoxConfig } from "../box-plane-runtime.js";
import { normalizeOutputText, readDetachedLog, resolveProcessOutcomeKind } from "./render.js";
import type { ProcessAction } from "./schema.js";

export async function executeDetachedBoxIdentityAction(input: {
  action: ProcessAction;
  boxId: string;
  executionId: string;
  timeoutMs: number;
  offset?: number;
  limit?: number;
  runtime?: BrewvaBundledToolRuntime;
}) {
  if (!["poll", "log", "kill"].includes(input.action)) {
    return errTextResult(`Action ${input.action} requires a managed sessionId.`, {
      status: "failed",
      backend: "box",
    });
  }

  const boxConfig = resolveRuntimeBoxConfig(input.runtime);
  const plane = resolveConfiguredBoxPlane(input.runtime, boxConfig);

  if (input.action === "kill") {
    const execution = await plane.reattach(input.boxId, input.executionId);
    if (!execution) {
      return errTextResult(
        `No detached box execution found for ${input.boxId}/${input.executionId}`,
        {
          status: "failed",
          backend: "box",
        },
      );
    }
    await execution.kill("SIGKILL");
    return errTextResult(`Termination requested for box execution ${input.executionId}.`, {
      status: "failed",
      backend: "box",
      boxId: input.boxId,
      executionId: input.executionId,
      reattached: true,
    });
  }

  let observation = await observeDetachedBoxExecution({
    plane,
    boxId: input.boxId,
    executionId: input.executionId,
    timeoutMs: input.action === "poll" ? input.timeoutMs : 0,
  });
  if (!observation) {
    return errTextResult(
      `No detached box execution found for ${input.boxId}/${input.executionId}`,
      {
        status: "failed",
        backend: "box",
      },
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

  return textResultForOutcome(
    resolveProcessOutcomeKind(observation.status),
    input.action === "poll" ? `${content}${suffix}` : content,
    {
      status: observation.status,
      backend: "box",
      boxId: input.boxId,
      executionId: input.executionId,
      exitCode: observation.exitCode,
      reattached: true,
    },
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
