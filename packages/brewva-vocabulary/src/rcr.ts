export {
  buildRcrReference,
  extractRcrContentPath,
  parseRcrReference,
  RCR_CONTENT_ABSENT,
  RCR_REFERENCE_SCHEMA_V1,
  resolveRcrReferenceAgainst,
} from "./internal/rcr.js";

export type {
  BuildRcrReferenceInput,
  RcrEventRef,
  RcrReference,
  RcrResolutionOutcome,
  RcrUnresolvableReason,
} from "./internal/rcr.js";
