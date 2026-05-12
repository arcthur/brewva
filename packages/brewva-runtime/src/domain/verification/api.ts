export { VERIFICATION_OUTCOME_SCHEMA, VERIFICATION_WRITE_MARKED_SCHEMA } from "./types.js";
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
} from "./types.js";
export { VERIFICATION_STATE_RESET_EVENT_TYPE } from "./events.js";
export {
  VERIFICATION_EVENT_DESCRIPTORS,
  VERIFICATION_OUTCOME_RECORDED_EVENT_DESCRIPTOR,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_DESCRIPTOR,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  readVerificationOutcomeRecordedEventPayload,
  readVerificationWriteMarkedEventPayload,
} from "./event-descriptors.js";
export {
  createVerificationSurfaceMethods,
  verificationRuntimeSurface,
  verificationSurfaceContribution,
} from "./runtime-surface.js";
export type {
  RuntimeVerificationSurfaceMethods,
  VerificationSurfaceDependencies,
} from "./runtime-surface.js";
export { registerVerificationDomain } from "./registrar.js";
export type { RuntimeVerificationDomainRegistration } from "./registrar.js";
export { isMutationTool } from "./classifier.js";
export { VerificationGate } from "./gate.js";
export {
  buildVerificationToolResultProjectionPayload,
  buildVerificationWriteMarkedPayload,
  readVerificationToolResultProjectionPayload,
} from "./projector-payloads.js";
export { VerificationProjectorService } from "./verification-projector.js";
export type { VerificationService } from "./verification.js";
export {
  GOVERNANCE_BLOCKER_ID,
  VERIFICATION_CHECK_FAILED_CLAIM_KIND,
  VERIFICATION_CHECK_MISSING_CLAIM_KIND,
  VERIFIER_BLOCKER_PREFIX,
} from "./verifier-blockers.js";
