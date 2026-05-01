import { readVerificationOutcomeRecordedEventPayload } from "../../../events/descriptors.js";
import {
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
} from "../../../events/registry.js";
import type { BrewvaEventRecord } from "../../../events/types.js";
import { collectVerificationCoverageTexts } from "../../workflow/api.js";
import {
  collectLatestPlanningOutputTimestamps,
  derivePlanningEvidenceState,
  resolveLatestWorkspaceWriteTimestamp,
} from "../planning-normalization.js";
import type { PlanningEvidenceKey, PlanningEvidenceState } from "../planning.js";
import type { VerificationEvidenceContext } from "./context.js";

export function deriveSkillPlanningEvidenceStateFromEvents(input: {
  events: readonly BrewvaEventRecord[];
  consumedOutputs: Record<string, unknown>;
}): Partial<Record<PlanningEvidenceKey, PlanningEvidenceState>> {
  return derivePlanningEvidenceState({
    consumedOutputs: input.consumedOutputs,
    latestOutputTimestamps: collectLatestPlanningOutputTimestamps(input.events),
    latestWriteAt: resolveLatestWorkspaceWriteTimestamp(input.events),
  });
}

export function resolveSkillVerificationEvidenceContext(
  events: readonly BrewvaEventRecord[],
): VerificationEvidenceContext {
  const latestWriteAt = events.reduce((max, event) => {
    return event.type === VERIFICATION_WRITE_MARKED_EVENT_TYPE ||
      event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE
      ? Math.max(max, event.timestamp)
      : max;
  }, 0);
  const verificationEvents = events
    .filter((event) => event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE)
    .toSorted((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  if (verificationEvents.length === 0) {
    // Verification evidence is runtime-authoritative. Consumed output artifacts may still exist,
    // but without a runtime verification receipt they do not count as present verification evidence.
    return { state: "missing", coverageTexts: [] };
  }

  let sawVerificationAfterLatestWrite = latestWriteAt === 0;
  let sawStaleVerification = false;
  for (let index = verificationEvents.length - 1; index >= 0; index -= 1) {
    const event = verificationEvents[index]!;
    if (event.timestamp < latestWriteAt) {
      break;
    }
    sawVerificationAfterLatestWrite = true;
    const payload = readVerificationOutcomeRecordedEventPayload(event);
    if (!payload) {
      continue;
    }
    if (payload.evidenceFreshness === "fresh") {
      return {
        state: "present",
        coverageTexts: collectVerificationCoverageTexts(payload),
      };
    }
    if (payload.evidenceFreshness === "stale" || payload.evidenceFreshness === "mixed") {
      sawStaleVerification = true;
    }
  }
  if (!sawVerificationAfterLatestWrite || sawStaleVerification) {
    return { state: "stale", coverageTexts: [] };
  }
  return { state: "missing", coverageTexts: [] };
}
