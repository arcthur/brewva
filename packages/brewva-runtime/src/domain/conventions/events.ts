export const CONVENTION_CANDIDATE_OBSERVED_EVENT_TYPE = "convention_candidate_observed" as const;
export const CONVENTION_CHANGE_REQUESTED_EVENT_TYPE = "convention_change_requested" as const;
export const CONVENTION_CHANGE_DECIDED_EVENT_TYPE = "convention_change_decided" as const;
export const CONVENTION_DECISION_RECEIPT_RECORDED_EVENT_TYPE =
  "convention_decision_receipt_recorded" as const;
export const CONVENTION_CHANGE_APPLIED_EVENT_TYPE = "convention_change_applied" as const;
export const CONVENTION_CONFLICT_DETECTED_EVENT_TYPE = "convention_conflict_detected" as const;
export const CONVENTION_HEALTH_DEGRADED_EVENT_TYPE = "convention_health_degraded" as const;
export const CONVENTION_CONTESTED_EVENT_TYPE = "convention_contested" as const;
export const CONVENTION_EMERGENCY_APPLIED_EVENT_TYPE = "convention_emergency_applied" as const;

export const CONVENTION_EVENT_TYPES = [
  CONVENTION_CANDIDATE_OBSERVED_EVENT_TYPE,
  CONVENTION_CHANGE_REQUESTED_EVENT_TYPE,
  CONVENTION_CHANGE_DECIDED_EVENT_TYPE,
  CONVENTION_DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  CONVENTION_CHANGE_APPLIED_EVENT_TYPE,
  CONVENTION_CONFLICT_DETECTED_EVENT_TYPE,
  CONVENTION_HEALTH_DEGRADED_EVENT_TYPE,
  CONVENTION_CONTESTED_EVENT_TYPE,
  CONVENTION_EMERGENCY_APPLIED_EVENT_TYPE,
] as const;
