export { registerWorkbenchDomain } from "./registrar.js";
export type { RuntimeWorkbenchDomainRegistration } from "./registrar.js";
export {
  WORKBENCH_BASELINE_COMMITTED_EVENT_DESCRIPTOR,
  WORKBENCH_BASELINE_COMMITTED_EVENT_TYPE,
  WORKBENCH_EVENT_DESCRIPTORS,
  WORKBENCH_EVICTION_RECORDED_EVENT_DESCRIPTOR,
  WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
  WORKBENCH_EVICTION_UNDONE_EVENT_DESCRIPTOR,
  WORKBENCH_EVICTION_UNDONE_EVENT_TYPE,
  WORKBENCH_NOTE_RECORDED_EVENT_DESCRIPTOR,
  WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
  readWorkbenchBaselineCommittedEventPayload,
  readWorkbenchEvictionRecordedEventPayload,
  readWorkbenchEvictionUndoneEventPayload,
  readWorkbenchNoteRecordedEventPayload,
} from "./event-descriptors.js";
export type {
  WorkbenchBaselineCommittedPayload,
  WorkbenchEvictionRecordedPayload,
  WorkbenchEvictionUndonePayload,
  WorkbenchNoteRecordedPayload,
} from "./event-descriptors.js";
export {
  WORKBENCH_EVICTION_SPAN_REF_PREFIXES,
  listInvalidWorkbenchEvictionSpanRefs,
  normalizeWorkbenchEvictionSpanRefs,
  parseWorkbenchEvictionSpanRef,
} from "./span-refs.js";
export type {
  ParsedWorkbenchEvictionSpanRef,
  WorkbenchEvictionSpanRefPrefix,
} from "./span-refs.js";
export {
  createWorkbenchSurfaceMethods,
  workbenchRuntimeSurface,
  workbenchSurfaceContribution,
} from "./runtime-surface.js";
export type {
  RuntimeWorkbenchSurfaceMethods,
  WorkbenchSurfaceDependencies,
} from "./runtime-surface.js";
export { WorkbenchService } from "./service.js";
export type {
  WorkbenchEntry,
  WorkbenchEntryKind,
  WorkbenchEvictInput,
  WorkbenchNoteInput,
  WorkbenchUndoEvictionResult,
} from "./types.js";
