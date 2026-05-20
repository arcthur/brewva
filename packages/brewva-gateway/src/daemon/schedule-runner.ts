import { type OperationalClaim } from "@brewva/brewva-runtime/protocol";
import type { TaskSpec } from "@brewva/brewva-runtime/protocol";
import type {
  ScheduleContinuityMode,
  ScheduleIntentProjectionRecord,
} from "@brewva/brewva-runtime/protocol";
import type { ManagedToolMode } from "@brewva/brewva-runtime/protocol";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";
import {
  getRuntimeClaimState,
  getRuntimeTapeStatus,
  getRuntimeTaskState,
  recordRuntimeScheduleChildFailed,
  recordRuntimeScheduleChildFinished,
  recordRuntimeScheduleChildStarted,
  recordRuntimeScheduleWakeup,
} from "../hosted/api.js";
import type {
  SchedulePromptAnchor,
  SchedulePromptTrigger,
  SessionBackend,
} from "./session-backend.js";

export interface ScheduleContinuationSnapshot {
  taskSpec: TaskSpec | null;
  claims: OperationalClaim[];
  parentAnchor: SchedulePromptAnchor | null;
}

function clampText(value: string | undefined, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

export function buildScheduleWorkerSessionId(input: {
  intentId: string;
  runIndex: number;
}): string {
  return `schedule:${input.intentId}:${input.runIndex}`;
}

export function collectScheduleContinuationSnapshot(
  runtime: HostedRuntimeAdapterPort,
  input: { parentSessionId: string; continuityMode: ScheduleContinuityMode },
): ScheduleContinuationSnapshot {
  if (input.continuityMode !== "inherit") {
    return {
      taskSpec: null,
      claims: [],
      parentAnchor: null,
    };
  }

  const parentAnchor = getRuntimeTapeStatus(runtime, input.parentSessionId).lastAnchor;
  const parentTask = getRuntimeTaskState(runtime, input.parentSessionId);
  const parentClaim = getRuntimeClaimState(runtime, input.parentSessionId);
  return {
    taskSpec: parentTask.spec ?? null,
    claims: parentClaim.claims.map((fact: OperationalClaim) => structuredClone(fact)),
    parentAnchor: parentAnchor ?? null,
  };
}

export function buildSchedulePromptTrigger(input: {
  continuityMode: ScheduleContinuityMode;
  snapshot: ScheduleContinuationSnapshot;
}): SchedulePromptTrigger {
  if (input.continuityMode !== "inherit") {
    return {
      kind: "schedule",
      continuityMode: input.continuityMode,
    };
  }

  return {
    kind: "schedule",
    continuityMode: input.continuityMode,
    taskSpec: input.snapshot.taskSpec,
    claims: input.snapshot.claims,
    parentAnchor: input.snapshot.parentAnchor,
  };
}

export function buildScheduleWakeupMessage(input: {
  intent: ScheduleIntentProjectionRecord;
  snapshot: ScheduleContinuationSnapshot;
}): string {
  const lines = ["[Schedule Wakeup]", `reason: ${input.intent.reason}`];

  if (input.intent.continuityMode === "fresh") {
    lines.push("Run this pass fresh. Prior task and claim state are not preloaded.");
  }
  if (input.snapshot.taskSpec) {
    lines.push(`task_goal: ${clampText(input.snapshot.taskSpec.goal, 320) ?? "none"}`);
  }
  const anchorSummary = clampText(input.snapshot.parentAnchor?.summary, 320);
  if (anchorSummary) {
    lines.push(`parent_anchor_summary: ${anchorSummary}`);
  }
  const nextSteps = clampText(input.snapshot.parentAnchor?.nextSteps, 320);
  if (nextSteps) {
    lines.push(`parent_anchor_next_steps: ${nextSteps}`);
  }

  lines.push("Continue from the recorded schedule intent and make concrete progress.");
  return lines.join("\n");
}

export async function executeScheduleIntentRun(input: {
  runtime: HostedRuntimeAdapterPort;
  backend: SessionBackend;
  intent: ScheduleIntentProjectionRecord;
  cwd?: string;
  configPath?: string;
  model?: string;
  managedToolMode?: ManagedToolMode;
}): Promise<{ evaluationSessionId: string; workerSessionId: string }> {
  const runIndex = input.intent.runCount + 1;
  const workerSessionId = buildScheduleWorkerSessionId({
    intentId: input.intent.intentId,
    runIndex,
  });
  const snapshot = collectScheduleContinuationSnapshot(input.runtime, {
    parentSessionId: input.intent.parentSessionId,
    continuityMode: input.intent.continuityMode,
  });
  const opened = await input.backend.openSession({
    sessionId: workerSessionId,
    cwd: input.cwd,
    configPath: input.configPath,
    model: input.model,
    managedToolMode: input.managedToolMode,
  });
  const agentSessionId = opened.agentSessionId?.trim() || workerSessionId;
  const wakeupMessage = buildScheduleWakeupMessage({
    intent: input.intent,
    snapshot,
  });
  const trigger = buildSchedulePromptTrigger({
    continuityMode: input.intent.continuityMode,
    snapshot,
  });

  recordRuntimeScheduleWakeup(input.runtime, agentSessionId, {
    schema: "brewva.schedule-wakeup.v1",
    intentId: input.intent.intentId,
    parentSessionId: input.intent.parentSessionId,
    runIndex,
    reason: input.intent.reason,
    continuityMode: input.intent.continuityMode,
    timeZone: input.intent.timeZone ?? null,
    goalRef: input.intent.goalRef ?? null,
    inheritedTaskSpec: snapshot.taskSpec !== null,
    inheritedOperationalClaims: snapshot.claims.length,
    parentAnchorId: snapshot.parentAnchor?.id ?? null,
  });
  recordRuntimeScheduleChildStarted(input.runtime, input.intent.parentSessionId, {
    intentId: input.intent.intentId,
    childSessionId: agentSessionId,
    runIndex,
  });

  try {
    const result = await input.backend.sendPrompt(workerSessionId, wakeupMessage, {
      waitForCompletion: true,
      source: "schedule",
      trigger,
    });
    const evaluationSessionId = result.agentSessionId?.trim() || agentSessionId;
    recordRuntimeScheduleChildFinished(input.runtime, input.intent.parentSessionId, {
      intentId: input.intent.intentId,
      childSessionId: evaluationSessionId,
      runIndex,
    });
    return {
      evaluationSessionId,
      workerSessionId,
    };
  } catch (error) {
    recordRuntimeScheduleChildFailed(input.runtime, input.intent.parentSessionId, {
      intentId: input.intent.intentId,
      childSessionId: agentSessionId,
      runIndex,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await input.backend.stopSession(workerSessionId, "schedule_run_complete").catch(() => false);
  }
}
