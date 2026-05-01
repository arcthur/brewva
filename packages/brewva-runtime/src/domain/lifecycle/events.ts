export const AGENT_END_EVENT_TYPE = "agent_end" as const;
export const MESSAGE_END_EVENT_TYPE = "message_end" as const;
export const MODEL_SELECT_EVENT_TYPE = "model_select" as const;
export const MODEL_PRESET_SELECT_EVENT_TYPE = "model_preset_select" as const;
export const SESSION_BEFORE_COMPACT_EVENT_TYPE = "session_before_compact" as const;
export const SESSION_BOOTSTRAP_EVENT_TYPE = "session_bootstrap" as const;
export const SESSION_COMPACT_EVENT_TYPE = "session_compact" as const;
export const SESSION_COMPACT_FAILED_EVENT_TYPE = "session_compact_failed" as const;
export const SESSION_COMPACT_REQUESTED_EVENT_TYPE = "session_compact_requested" as const;
export const SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE = "session_compact_request_failed" as const;
export const SESSION_SHUTDOWN_EVENT_TYPE = "session_shutdown" as const;
export const SESSION_START_EVENT_TYPE = "session_start" as const;
export const SESSION_REWIND_CHECKPOINT_RECORDED_EVENT_TYPE =
  "brewva.session.rewind.checkpoint.v1" as const;
export const SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE = "brewva.session.rewind.redo.v1" as const;
export const SESSION_REWIND_SUPERSEDED_EVENT_TYPE = "brewva.session.rewind.superseded.v1" as const;
export const TURN_START_EVENT_TYPE = "turn_start" as const;
export const TURN_END_EVENT_TYPE = "turn_end" as const;
