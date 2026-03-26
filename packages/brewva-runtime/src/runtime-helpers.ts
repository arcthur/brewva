import type { BrewvaEventCategory, TaskState } from "./contracts/index.js";
import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "./tape/events.js";
import { formatTaskStateBlock } from "./task/ledger.js";

export function inferEventCategory(type: string): BrewvaEventCategory {
  if (type === TAPE_ANCHOR_EVENT_TYPE || type === TAPE_CHECKPOINT_EVENT_TYPE) {
    return "state";
  }
  if (type.startsWith("projection_")) return "state";
  if (
    type.startsWith("session_") ||
    type.startsWith("channel_session_") ||
    type.startsWith("model_") ||
    type === "session_start" ||
    type === "session_shutdown"
  )
    return "session";
  if (type.startsWith("turn_") || type.startsWith("channel_turn_")) return "turn";
  if (type.startsWith("iteration_")) return "state";
  if (type.includes("tool") || type.startsWith("patch_") || type === "rollback") return "tool";
  if (type.startsWith("context_")) return "context";
  if (type.startsWith("cost_") || type.startsWith("budget_")) return "cost";
  if (type.startsWith("verification_")) return "verification";
  if (type.startsWith("proposal_") || type.startsWith("decision_receipt_")) return "governance";
  if (type.startsWith("governance_")) return "governance";
  if (type.includes("snapshot") || type.includes("resumed") || type.includes("interrupted"))
    return "state";
  return "other";
}

export function buildTaskStateBlock(state: TaskState): string {
  return formatTaskStateBlock(state);
}
