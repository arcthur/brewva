import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { SchedulePromptTrigger } from "../daemon/session-backend.js";

export interface AppliedSchedulePromptTrigger {
  taskSpecApplied: boolean;
  truthFactsApplied: number;
  anchorApplied: boolean;
  skillApplied: boolean;
  skillActivationReason?: string;
}

export function applySchedulePromptTrigger(
  runtime: Pick<BrewvaHostedRuntimePort, "authority">,
  sessionId: string,
  trigger: SchedulePromptTrigger,
): AppliedSchedulePromptTrigger {
  if (trigger.continuityMode !== "inherit") {
    return {
      taskSpecApplied: false,
      truthFactsApplied: 0,
      anchorApplied: false,
      skillApplied: false,
      skillActivationReason: undefined,
    };
  }

  let taskSpecApplied = false;
  if (trigger.taskSpec) {
    runtime.authority.task.setSpec(sessionId, trigger.taskSpec);
    taskSpecApplied = true;
  }

  let truthFactsApplied = 0;
  for (const fact of trigger.truthFacts ?? []) {
    const result = runtime.authority.truth.upsertFact(sessionId, {
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
    runtime.authority.tape.recordTapeHandoff(sessionId, {
      name: `schedule:inherit:${trigger.parentAnchor.name ?? "parent"}`,
      summary: trigger.parentAnchor.summary,
      nextSteps: trigger.parentAnchor.nextSteps,
    });
    anchorApplied = true;
  }

  let skillApplied = false;
  let skillActivationReason: string | undefined;
  if (trigger.activeSkillName) {
    const activated = runtime.authority.skills.activate(sessionId, trigger.activeSkillName);
    skillApplied = activated.ok;
    if (!activated.ok) {
      skillActivationReason = activated.reason;
    }
  }

  return {
    taskSpecApplied,
    truthFactsApplied,
    anchorApplied,
    skillApplied,
    skillActivationReason,
  };
}
