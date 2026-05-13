// Curated verification contract subpath. Keep root imports focused on createBrewvaRuntime and explicit port types.
export {
  VERIFICATION_OUTCOME_SCHEMA,
  VERIFICATION_WRITE_MARKED_SCHEMA,
} from "./domain/verification/types.js";
export type {
  VerificationCheckRun,
  VerificationCheckStatus,
  VerificationEvidenceFreshness,
  VerificationOutcome,
  VerificationOutcomeCheckProvenance,
  VerificationOutcomeCheckResult,
  VerificationOutcomeRecordedEventPayload,
  VerificationReport,
  VerificationSessionState,
  VerificationWriteMarkedEventPayload,
} from "./domain/verification/types.js";
