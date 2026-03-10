import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { SchedulePromptTrigger } from "../daemon/session-backend.js";

export interface AppliedSchedulePromptTrigger {
  taskSpecApplied: boolean;
  truthFactsApplied: number;
  anchorApplied: boolean;
}

export function applySchedulePromptTrigger(
  runtime: Pick<BrewvaRuntime, "task" | "truth" | "events">,
  sessionId: string,
  trigger: SchedulePromptTrigger,
): AppliedSchedulePromptTrigger {
  if (trigger.continuityMode !== "inherit") {
    return {
      taskSpecApplied: false,
      truthFactsApplied: 0,
      anchorApplied: false,
    };
  }

  let taskSpecApplied = false;
  if (trigger.taskSpec) {
    runtime.task.setSpec(sessionId, trigger.taskSpec);
    taskSpecApplied = true;
  }

  let truthFactsApplied = 0;
  for (const fact of trigger.truthFacts ?? []) {
    const result = runtime.truth.upsertFact(sessionId, {
      id: fact.id,
      kind: fact.kind,
      severity: fact.severity,
      summary: fact.summary,
      details: fact.details,
      evidenceIds: fact.evidenceIds,
      status: fact.status,
    });
    if (result.ok) {
      truthFactsApplied += 1;
    }
  }

  let anchorApplied = false;
  if (trigger.parentAnchor) {
    runtime.events.recordTapeHandoff(sessionId, {
      name: `schedule:inherit:${trigger.parentAnchor.name ?? "parent"}`,
      summary: trigger.parentAnchor.summary,
      nextSteps: trigger.parentAnchor.nextSteps,
    });
    anchorApplied = true;
  }

  return {
    taskSpecApplied,
    truthFactsApplied,
    anchorApplied,
  };
}
