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
  const parentAnchor = runtime.events.getTapeStatus(input.parentSessionId).lastAnchor;
  if (input.continuityMode !== "inherit") {
    return {
      taskSpec: null,
      truthFacts: [],
      parentAnchor: parentAnchor ?? null,
    };
  }

  const parentTask = runtime.task.getState(input.parentSessionId);
  const parentTruth = runtime.truth.getState(input.parentSessionId);
  return {
    taskSpec: parentTask.spec ?? null,
    truthFacts: parentTruth.facts.map((fact) => structuredClone(fact)),
    parentAnchor: parentAnchor ?? null,
  };
}

export function buildSchedulePromptTrigger(input: {
  intent: ScheduleIntentProjectionRecord;
  runIndex: number;
  snapshot: ScheduleContinuationSnapshot;
}): SchedulePromptTrigger {
  return {
    kind: "schedule",
    intentId: input.intent.intentId,
    parentSessionId: input.intent.parentSessionId,
    runIndex: input.runIndex,
    reason: input.intent.reason,
    continuityMode: input.intent.continuityMode,
    timeZone: input.intent.timeZone,
    goalRef: input.intent.goalRef,
    taskSpec: input.snapshot.taskSpec,
    truthFacts: input.snapshot.truthFacts,
    parentAnchor: input.snapshot.parentAnchor,
  };
}

export function buildScheduleWakeupMessage(input: {
  intent: ScheduleIntentProjectionRecord;
  runIndex: number;
  snapshot: ScheduleContinuationSnapshot;
}): string {
  const anchor = input.snapshot.parentAnchor;
  const lines = [
    "[Schedule Wakeup]",
    `intent_id: ${input.intent.intentId}`,
    `parent_session_id: ${input.intent.parentSessionId}`,
    `run_index: ${input.runIndex}`,
    `reason: ${input.intent.reason}`,
    `continuity_mode: ${input.intent.continuityMode}`,
    `time_zone: ${input.intent.timeZone ?? "none"}`,
    `goal_ref: ${input.intent.goalRef ?? "none"}`,
    `inherited_task_spec: ${input.snapshot.taskSpec ? "yes" : "no"}`,
    `inherited_truth_facts: ${input.snapshot.truthFacts.length}`,
    `parent_anchor_id: ${anchor?.id ?? "none"}`,
    `parent_anchor_name: ${anchor?.name ?? "none"}`,
  ];

  if (input.snapshot.taskSpec) {
    lines.push(`task_goal: ${clampText(input.snapshot.taskSpec.goal, 320) ?? "none"}`);
  }
  const anchorSummary = clampText(anchor?.summary, 320);
  if (anchorSummary) {
    lines.push(`parent_anchor_summary: ${anchorSummary}`);
  }
  const nextSteps = clampText(anchor?.nextSteps, 320);
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
    runIndex,
    snapshot,
  });
  const trigger = buildSchedulePromptTrigger({
    intent: input.intent,
    runIndex,
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
