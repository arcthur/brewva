// Curated reasoning contract subpath. Keep root imports focused on BrewvaRuntime.
export {
  MAX_REASONING_CONTINUITY_BYTES,
  REASONING_CONTINUITY_SCHEMA,
} from "./domain/reasoning/types.js";
export type {
  ActiveReasoningBranchState,
  ReasoningCheckpointBoundary,
  ReasoningCheckpointRecord,
  ReasoningContinuityPacket,
  ReasoningRevertInput,
  ReasoningRevertRecord,
  ReasoningRevertTrigger,
  RecordReasoningCheckpointInput,
} from "./domain/reasoning/types.js";
export { buildReasoningRevertSummaryDetails } from "./domain/reasoning/revert-summary.js";
export {
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
} from "./domain/reasoning/events.js";
export {
  REASONING_CHECKPOINT_SCHEMA,
  REASONING_REVERT_SCHEMA,
  buildReasoningCheckpointPayload,
  buildReasoningRevertPayload,
  coerceReasoningCheckpointPayload,
  coerceReasoningContinuityPacket,
  coerceReasoningRevertPayload,
  normalizeReasoningContinuityPacket,
} from "./domain/reasoning/payloads.js";
export type {
  ReasoningCheckpointPayload,
  ReasoningRevertPayload,
} from "./domain/reasoning/payloads.js";
