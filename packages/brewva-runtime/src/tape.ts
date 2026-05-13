// Curated tape contract subpath. Keep root imports focused on BrewvaRuntime.
export { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "./domain/tape/events.js";
export {
  TAPE_ANCHOR_SCHEMA,
  TAPE_CHECKPOINT_SCHEMA,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
  coerceTapeAnchorPayload,
  coerceTapeCheckpointPayload,
} from "./domain/tape/payloads.js";
export type {
  TapeAnchorPayload,
  TapeCheckpointEvidenceState,
  TapeCheckpointFailureClassCounts,
  TapeCheckpointPayload,
  TapeCheckpointProjectionState,
  TapeCheckpointToolFailureEntry,
} from "./domain/tape/payloads.js";
