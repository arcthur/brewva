// Curated task contract subpath. Keep root imports focused on BrewvaRuntime.
export { isHydratedTaskState } from "./domain/task/types.js";
export type {
  HydratedTaskState,
  TaskAcceptanceRecordResult,
  TaskAcceptanceState,
  TaskAcceptanceStatus,
  TaskBlocker,
  TaskBlockerRecordResult,
  TaskBlockerResolveResult,
  TaskHealth,
  TaskItem,
  TaskItemAddResult,
  TaskItemStatus,
  TaskItemUpdateResult,
  TaskLedgerEventPayload,
  TaskPhase,
  TaskSpec,
  TaskSpecSchema,
  TaskState,
  TaskStatus,
  TaskTargetDescriptor,
} from "./domain/task/types.js";
export { normalizeTaskSpec, parseTaskSpec } from "./domain/task/spec.js";
export {
  TASK_EVENT_TYPE,
  TASK_LEDGER_SCHEMA,
  buildAcceptanceSetEvent,
  buildBlockerRecordedEvent,
  buildBlockerResolvedEvent,
  buildCheckpointSetEvent,
  buildItemAddedEvent,
  buildItemUpdatedEvent,
  buildSpecSetEvent,
  buildStatusSetEvent,
  coerceTaskLedgerPayload,
  createEmptyTaskState,
  foldTaskLedgerEvents,
  formatTaskStateBlock,
  isTaskLedgerPayload,
  reduceTaskState,
} from "./domain/task/ledger.js";
export {
  TASK_AGENT_ITEM_STATUS_RUNTIME_MAP,
  TASK_AGENT_ITEM_STATUS_VALUES,
  formatTaskItemStatusForSurface,
  formatTaskVerificationLevelForSurface,
} from "./domain/task/surface.js";
export type { TaskAgentItemStatus } from "./domain/task/surface.js";
export {
  TASK_STALL_ADJUDICATION_SCHEMA,
  TASK_WATCHDOG_SCHEMA,
  buildTaskStallAdjudicatedPayload,
  buildTaskStuckClearedPayload,
  buildTaskStuckDetectedPayload,
  coerceTaskStallAdjudicatedPayload,
  coerceTaskStuckDetectedPayload,
  computeTaskSemanticProgressAt,
  evaluateTaskWatchdogEligibility,
  getTaskWatchdogOpenItemCount,
  isTaskWatchdogEventType,
  toTaskWatchdogEventPayload,
} from "./domain/task/watchdog.js";
export type {
  TaskStallAdjudicatedPayload,
  TaskStallAdjudicationDecision,
  TaskStuckClearedPayload,
  TaskStuckDetectedPayload,
  TaskWatchdogEligibility,
} from "./domain/task/watchdog.js";
