export const COMPACTION_RESUME_PROMPT =
  "Context compaction completed. Resume the interrupted turn from the current task and evidence state. Do not repeat completed tool side effects unless required for correctness. Finish the pending response.";

export const MAX_OUTPUT_RECOVERY_PROMPT =
  "The previous assistant response exceeded the output budget. Continue from the current task and evidence state, but finish more concisely. Do not repeat prior content or replay completed tool side effects. Deliver only the highest-value remaining answer.";

export const PROVIDER_FALLBACK_RECOVERY_PROMPT =
  "The previous model request failed before the turn could complete. Continue from the current task and evidence state. Do not repeat completed tool side effects. Resume the pending response.";
