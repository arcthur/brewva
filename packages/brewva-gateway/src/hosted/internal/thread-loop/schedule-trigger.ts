import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { SchedulePromptTrigger } from "../../../daemon/api.js";

export interface AppliedSchedulePromptTrigger {
  taskSpecApplied: boolean;
  claimsApplied: number;
  anchorApplied: boolean;
}

export function applySchedulePromptTrigger(
  runtime: Pick<BrewvaHostedRuntimePort, "authority">,
  sessionId: string,
  trigger: SchedulePromptTrigger,
): AppliedSchedulePromptTrigger {
  if (trigger.continuityMode !== "inherit") {
    return {
      taskSpecApplied: false,
      claimsApplied: 0,
      anchorApplied: false,
    };
  }

  let taskSpecApplied = false;
  if (trigger.taskSpec) {
    runtime.authority.task.spec.set(sessionId, trigger.taskSpec);
    taskSpecApplied = true;
  }

  let claimsApplied = 0;
  for (const fact of trigger.claims ?? []) {
    const result = runtime.authority.claim.facts.upsert(sessionId, {
      id: fact.id,
      kind: fact.kind,
      severity: fact.severity,
      summary: fact.summary,
      details: fact.details,
      evidenceIds: fact.evidenceIds,
      status: fact.status,
    });
    if (result.ok) {
      claimsApplied += 1;
    }
  }

  let anchorApplied = false;
  if (trigger.parentAnchor) {
    runtime.authority.tape.handoff.record(sessionId, {
      name: `schedule:inherit:${trigger.parentAnchor.name ?? "parent"}`,
      summary: trigger.parentAnchor.summary,
      nextSteps: trigger.parentAnchor.nextSteps,
    });
    anchorApplied = true;
  }

  return {
    taskSpecApplied,
    claimsApplied,
    anchorApplied,
  };
}
