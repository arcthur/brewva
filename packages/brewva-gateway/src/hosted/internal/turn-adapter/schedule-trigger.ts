import type { SchedulePromptTrigger } from "../../../daemon/api.js";
import {
  hasRuntimeOpsAdapter,
  recordRuntimeTapeHandoff,
  setRuntimeTaskSpec,
  type HostedRuntimeAdapterPort,
  upsertRuntimeClaimFact,
} from "../session/runtime-ports.js";

export interface AppliedSchedulePromptTrigger {
  taskSpecApplied: boolean;
  claimsApplied: number;
  anchorApplied: boolean;
}

const NO_SCHEDULE_PROMPT_TRIGGER: AppliedSchedulePromptTrigger = {
  taskSpecApplied: false,
  claimsApplied: 0,
  anchorApplied: false,
};

function isSchedulePromptTrigger(trigger: unknown): trigger is SchedulePromptTrigger {
  return (
    typeof trigger === "object" &&
    trigger !== null &&
    "kind" in trigger &&
    trigger.kind === "schedule" &&
    "continuityMode" in trigger
  );
}

export function tryApplySchedulePromptTrigger(
  runtime: unknown,
  sessionId: string,
  trigger: unknown,
): AppliedSchedulePromptTrigger {
  if (!hasRuntimeOpsAdapter(runtime) || !isSchedulePromptTrigger(trigger)) {
    return NO_SCHEDULE_PROMPT_TRIGGER;
  }
  return applySchedulePromptTrigger(runtime, sessionId, trigger);
}

export function applySchedulePromptTrigger(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  trigger: SchedulePromptTrigger,
): AppliedSchedulePromptTrigger {
  if (trigger.continuityMode !== "inherit") {
    return NO_SCHEDULE_PROMPT_TRIGGER;
  }

  let taskSpecApplied = false;
  if (trigger.taskSpec) {
    setRuntimeTaskSpec(runtime, sessionId, trigger.taskSpec);
    taskSpecApplied = true;
  }

  let claimsApplied = 0;
  for (const fact of trigger.claims ?? []) {
    const result = upsertRuntimeClaimFact(runtime, sessionId, {
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
    recordRuntimeTapeHandoff(runtime, sessionId, {
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
