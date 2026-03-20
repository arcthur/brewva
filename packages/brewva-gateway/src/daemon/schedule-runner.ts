import {
  BrewvaRuntime,
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  type ScheduleContinuityMode,
  type ScheduleIntentProjectionRecord,
  type TaskSpec,
  type TruthFact,
} from "@brewva/brewva-runtime";
import type {
  SchedulePromptAnchor,
  SchedulePromptTrigger,
  SessionBackend,
} from "./session-backend.js";

export interface ScheduleContinuationSnapshot {
  taskSpec: TaskSpec | null;
  truthFacts: TruthFact[];
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
  runtime: BrewvaRuntime,
  input: { parentSessionId: string; continuityMode: ScheduleContinuityMode },
): ScheduleContinuationSnapshot {
  if (input.continuityMode !== "inherit") {
    return {
      taskSpec: null,
      truthFacts: [],
      parentAnchor: null,
    };
  }

  const parentAnchor = runtime.events.getTapeStatus(input.parentSessionId).lastAnchor;
  const parentTask = runtime.task.getState(input.parentSessionId);
  const parentTruth = runtime.truth.getState(input.parentSessionId);
  return {
    taskSpec: parentTask.spec ?? null,
    truthFacts: parentTruth.facts.map((fact) => structuredClone(fact)),
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
    truthFacts: input.snapshot.truthFacts,
    parentAnchor: input.snapshot.parentAnchor,
  };
}

export function buildScheduleWakeupMessage(input: {
  intent: ScheduleIntentProjectionRecord;
  snapshot: ScheduleContinuationSnapshot;
}): string {
  const lines = ["[Schedule Wakeup]", `reason: ${input.intent.reason}`];

  if (input.intent.continuityMode === "fresh") {
    lines.push("Run this pass fresh. Prior task and truth state are not preloaded.");
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
  runtime: BrewvaRuntime;
  backend: SessionBackend;
  intent: ScheduleIntentProjectionRecord;
  cwd?: string;
  configPath?: string;
  model?: string;
  enableExtensions?: boolean;
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
    enableExtensions: input.enableExtensions,
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

  input.runtime.events.record({
    sessionId: agentSessionId,
    type: SCHEDULE_WAKEUP_EVENT_TYPE,
    payload: {
      schema: "brewva.schedule-wakeup.v1",
      intentId: input.intent.intentId,
      parentSessionId: input.intent.parentSessionId,
      runIndex,
      reason: input.intent.reason,
      continuityMode: input.intent.continuityMode,
      timeZone: input.intent.timeZone ?? null,
      goalRef: input.intent.goalRef ?? null,
      inheritedTaskSpec: snapshot.taskSpec !== null,
      inheritedTruthFacts: snapshot.truthFacts.length,
      parentAnchorId: snapshot.parentAnchor?.id ?? null,
    },
  });
  input.runtime.events.record({
    sessionId: input.intent.parentSessionId,
    type: SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
    payload: {
      intentId: input.intent.intentId,
      childSessionId: agentSessionId,
      runIndex,
    },
  });

  try {
    const result = await input.backend.sendPrompt(workerSessionId, wakeupMessage, {
      waitForCompletion: true,
      source: "schedule",
      trigger,
    });
    const evaluationSessionId = result.agentSessionId?.trim() || agentSessionId;
    input.runtime.events.record({
      sessionId: input.intent.parentSessionId,
      type: SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
      payload: {
        intentId: input.intent.intentId,
        childSessionId: evaluationSessionId,
        runIndex,
      },
    });
    return {
      evaluationSessionId,
      workerSessionId,
    };
  } catch (error) {
    input.runtime.events.record({
      sessionId: input.intent.parentSessionId,
      type: SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
      payload: {
        intentId: input.intent.intentId,
        childSessionId: agentSessionId,
        runIndex,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    await input.backend.stopSession(workerSessionId, "schedule_run_complete").catch(() => false);
  }
}
