import { normalizeStringList, readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import {
  RUNTIME_OPS_TOOL_CALL_ENDED_KIND,
  RUNTIME_OPS_TOOL_CALL_OBSERVED_KIND,
  RUNTIME_OPS_TOOL_CALL_STARTED_KIND,
  RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
  RUNTIME_OPS_TOOL_RESULT_RECORDED_KIND,
  type ProtocolRecord,
} from "@brewva/brewva-vocabulary/events";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V2,
  type SessionCompactionAttentionRefs,
  type SessionCompactionInputProvenance,
  type SessionCompactionRecallResultRef,
  type SessionCompactionResourceRef,
} from "@brewva/brewva-vocabulary/session";
import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";

interface CompactionProvenanceEvent {
  readonly type: string;
  readonly payload?: unknown;
}

interface CompactionProvenanceInput {
  readonly workbenchEntries: readonly WorkbenchEntry[];
  readonly skillSelection?: unknown;
  readonly capabilitySelection?: unknown;
  readonly recallEvents: readonly CompactionProvenanceEvent[];
  readonly usageEvents?: readonly CompactionProvenanceEvent[];
  readonly attentionEvents?: readonly CompactionProvenanceEvent[];
  readonly compactBaseline?: unknown;
  readonly recallTokenBudget?: number | null;
}

const RECALL_SOURCE_FAMILIES = ["tape_evidence", "repository_precedent"] as const;
const RECALL_SESSION_SCOPES = ["current_session", "prior_session", "cross_workspace"] as const;
const RECALL_STABLE_ID_PATTERN = /\b(?:tape:[^\s'",\]}]+|precedent:[^\s'",\]}]+)/gu;
export const RECALL_USAGE_EVENT_TYPES = [
  RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
  RUNTIME_OPS_TOOL_RESULT_RECORDED_KIND,
  RUNTIME_OPS_TOOL_CALL_OBSERVED_KIND,
  RUNTIME_OPS_TOOL_CALL_STARTED_KIND,
  RUNTIME_OPS_TOOL_CALL_ENDED_KIND,
] as const;
const RECALL_USAGE_EVENT_TYPE_SET = new Set<string>(RECALL_USAGE_EVENT_TYPES);
export const ATTENTION_METRIC_EVENT_TYPE = "iteration.metric.observed" as const;
const MAX_COMPACTION_RECALL_RESULT_REFS = 8;

// One used recall ref is budgeted as a compact provenance pointer plus its projected summary.
const RECALL_RESULT_REF_TOKEN_AMORTIZATION = 400;

function stringOrNull(value: unknown): string | null {
  return readNonEmptyString(value) ?? null;
}

function readStringArray(value: unknown): string[] {
  return [...new Set(normalizeStringList(value))];
}

function readRecallSourceFamily(
  value: unknown,
): SessionCompactionRecallResultRef["sourceFamily"] | null {
  const normalized = stringOrNull(value);
  return normalized && (RECALL_SOURCE_FAMILIES as readonly string[]).includes(normalized)
    ? (normalized as SessionCompactionRecallResultRef["sourceFamily"])
    : null;
}

function readRecallSessionScope(
  value: unknown,
): SessionCompactionRecallResultRef["sessionScope"] | null {
  const normalized = stringOrNull(value);
  return normalized && (RECALL_SESSION_SCOPES as readonly string[]).includes(normalized)
    ? (normalized as SessionCompactionRecallResultRef["sessionScope"])
    : null;
}

function decodeUriComponentSafely(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeStructuredFilePath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let candidate = trimmed;
  if (candidate.startsWith("brewva-resource:///file/")) {
    const decoded = decodeUriComponentSafely(candidate.slice("brewva-resource:///file/".length));
    if (decoded === null) return null;
    candidate = decoded;
  } else if (candidate.startsWith("brewva-resource:///")) {
    return null;
  } else if (candidate.startsWith("file://")) {
    const decoded = decodeUriComponentSafely(candidate.slice("file://".length));
    if (decoded === null) return null;
    candidate = decoded;
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(candidate)) {
    return null;
  } else {
    candidate = candidate.replace(/^(?:precedent|file|repo|workspace|source|modified|patch):/u, "");
  }
  const normalized = candidate.replace(/^\/repo\//u, "").replace(/^\/workspace\//u, "");
  if (!/[/.]/u.test(normalized)) {
    return null;
  }
  if (!/\.[A-Za-z0-9]{1,12}(?:$|[#?])/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function readFilePath(value: unknown): string | null {
  const raw = stringOrNull(value);
  return raw ? normalizeStructuredFilePath(raw) : null;
}

function readFilePathArray(value: unknown): string[] {
  return readStringArray(value)
    .map(normalizeStructuredFilePath)
    .filter((entry): entry is string => entry !== null);
}

function dedupeRecords<T extends ProtocolRecord>(
  records: readonly T[],
  keyOf: (record: T) => string,
): T[] {
  const deduped = new Map<string, T>();
  for (const record of records) {
    const key = keyOf(record);
    if (!deduped.has(key)) {
      deduped.set(key, record);
    }
  }
  return [...deduped.values()];
}

function readSkillInvocationRecords(skillSelection: unknown): ProtocolRecord[] {
  if (!isRecord(skillSelection) || !Array.isArray(skillSelection.skillInvocationRecords)) {
    return [];
  }
  return skillSelection.skillInvocationRecords.filter(isRecord);
}

function readSelectedSkillInvocationIds(skillSelection: unknown): string[] {
  return readSkillInvocationRecords(skillSelection)
    .map((record) => stringOrNull(record.invocationId))
    .filter((entry): entry is string => entry !== null);
}

function readResourceRef(value: unknown): SessionCompactionResourceRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = stringOrNull(value.kind);
  const path = stringOrNull(value.path);
  if ((kind !== "reference" && kind !== "script" && kind !== "invariant") || path === null) {
    return null;
  }
  return { kind, path };
}

function readSurfacedResourceRefs(skillSelection: unknown): SessionCompactionResourceRef[] {
  return dedupeRecords(
    readSkillInvocationRecords(skillSelection).flatMap((record) =>
      Array.isArray(record.resourceRefs)
        ? record.resourceRefs
            .map(readResourceRef)
            .filter((ref): ref is SessionCompactionResourceRef => ref !== null)
        : [],
    ),
    (record) => `${record.kind}:${record.path}`,
  );
}

function readSkillResourceFiles(skillSelection: unknown): string[] {
  return readSurfacedResourceRefs(skillSelection)
    .map((ref) => normalizeStructuredFilePath(ref.path))
    .filter((entry): entry is string => entry !== null);
}

function readCapabilityReceiptRefs(capabilitySelection: unknown): string[] {
  if (!isRecord(capabilitySelection)) {
    return [];
  }
  const selectionId = stringOrNull(capabilitySelection.selectionId);
  if (selectionId) {
    return [selectionId];
  }
  return readStringArray(capabilitySelection.selectedCapabilities);
}

function readRecallResultRef(value: unknown): SessionCompactionRecallResultRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const stableId = stringOrNull(value.stableId);
  const sourceFamily = readRecallSourceFamily(value.sourceFamily);
  const sessionScope = readRecallSessionScope(value.sessionScope);
  const rootRef = stringOrNull(value.rootRef);
  if (!stableId || !sourceFamily || !sessionScope || !rootRef) {
    return null;
  }
  return {
    stableId,
    sourceFamily,
    sessionScope,
    rootRef,
  };
}

function readRecallRefsFromEvent(
  event: CompactionProvenanceEvent,
): SessionCompactionRecallResultRef[] {
  if (!isRecord(event.payload) || !Array.isArray(event.payload.results)) {
    return [];
  }
  return event.payload.results
    .map(readRecallResultRef)
    .filter((entry): entry is SessionCompactionRecallResultRef => entry !== null);
}

function extractRecallStableIdsFromSourceRefs(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(RECALL_STABLE_ID_PATTERN)].map((match) => match[0]);
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractRecallStableIdsFromSourceRefs);
  }
  return [];
}

function readRecallStableId(value: unknown): string | null {
  const stableId = stringOrNull(value);
  return stableId && /^(?:tape:|precedent:)\S+$/u.test(stableId) ? stableId : null;
}

function readRecallStableIdsFromStableIdValues(value: unknown): string[] {
  const stableId = readRecallStableId(value);
  if (stableId) {
    return [stableId];
  }
  if (Array.isArray(value)) {
    return value.flatMap(readRecallStableIdsFromStableIdValues);
  }
  if (isRecord(value)) {
    return readRecallStableIdsFromStableIdValues(value.stableId);
  }
  return [];
}

function readRecallStableIdsFromUsagePayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  return readStringArray([
    ...extractRecallStableIdsFromSourceRefs(payload.sourceRefs),
    ...readRecallStableIdsFromStableIdValues(payload.stableIds),
    ...readRecallStableIdsFromStableIdValues(payload.recallStableIds),
    ...readRecallStableIdsFromStableIdValues(payload.result),
    ...readRecallStableIdsFromStableIdValues(payload.results),
  ]);
}

function readRecallStableIdsFromWorkbench(workbenchEntries: readonly WorkbenchEntry[]): string[] {
  return workbenchEntries.flatMap((entry) =>
    extractRecallStableIdsFromSourceRefs(entry.sourceRefs),
  );
}

function readFilePathsFromWorkbench(workbenchEntries: readonly WorkbenchEntry[]): string[] {
  return readStringArray(
    workbenchEntries.flatMap((entry) => entry.sourceRefs).map(normalizeStructuredFilePath),
  );
}

function readReadFilesFromPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const direct = readFilePathArray(payload.readFiles);
  const primaryPath = readFilePath(payload.path);
  const primaryUri = readFilePath(payload.uri);
  const sourceSnapshotPath = isRecord(payload.sourceSnapshot)
    ? (readFilePath(payload.sourceSnapshot.path) ?? readFilePath(payload.sourceSnapshot.uri))
    : null;
  const sourceResourcePath = isRecord(payload.sourceResource)
    ? (readFilePath(payload.sourceResource.path) ?? readFilePath(payload.sourceResource.uri))
    : null;
  return readStringArray([
    ...direct,
    ...(primaryPath ? [primaryPath] : []),
    ...(primaryUri ? [primaryUri] : []),
    ...(sourceSnapshotPath ? [sourceSnapshotPath] : []),
    ...(sourceResourcePath ? [sourceResourcePath] : []),
  ]);
}

function readReadFilesFromEvents(events: readonly CompactionProvenanceEvent[]): string[] {
  return readStringArray(events.flatMap((event) => readReadFilesFromPayload(event.payload)));
}

function readFilePathFromRecallRef(ref: SessionCompactionRecallResultRef): string | null {
  const fromStableId = normalizeStructuredFilePath(ref.stableId);
  if (fromStableId) {
    return fromStableId;
  }
  return normalizeStructuredFilePath(ref.rootRef);
}

function readModifiedFilesFromPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const direct = readFilePathArray(payload.modifiedFiles);
  const applied = readFilePathArray(payload.appliedPaths);
  const created = readFilePathArray(payload.createdFiles);
  const deleted = readFilePathArray(payload.deletedFiles);
  const patched = readFilePathArray(payload.patchedFiles);
  const written = readFilePathArray(payload.writtenFiles);
  const sourcePatchFiles = isRecord(payload.sourcePatch)
    ? readStringArray([
        ...readFilePathArray(payload.sourcePatch.modifiedFiles),
        ...readFilePathArray(payload.sourcePatch.appliedPaths),
        ...readFilePathArray(payload.sourcePatch.createdFiles),
        ...readFilePathArray(payload.sourcePatch.deletedFiles),
      ])
    : [];
  const paths = Array.isArray(payload.files)
    ? payload.files.flatMap((entry) => {
        if (!isRecord(entry)) {
          return [];
        }
        const action = stringOrNull(entry.action) ?? stringOrNull(entry.status);
        if (
          action !== "modified" &&
          action !== "written" &&
          action !== "patched" &&
          action !== "created" &&
          action !== "added" &&
          action !== "deleted" &&
          action !== "renamed"
        ) {
          return [];
        }
        const path = readFilePath(entry.path);
        return path ? [path] : [];
      })
    : [];
  return readStringArray([
    ...direct,
    ...applied,
    ...created,
    ...deleted,
    ...patched,
    ...written,
    ...sourcePatchFiles,
    ...paths,
  ]);
}

function readModifiedFilesFromEvents(events: readonly CompactionProvenanceEvent[]): string[] {
  return readStringArray(events.flatMap((event) => readModifiedFilesFromPayload(event.payload)));
}

function readAttentionOptionRef(value: unknown): string | null {
  return stringOrNull(value);
}

function readAttentionOptionRefFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return (
    readAttentionOptionRef(payload.optionId) ??
    readStringArray(payload.evidenceRefs).map(readAttentionOptionRef).find(Boolean) ??
    null
  );
}

function readAttentionRefsFromEvents(
  events: readonly CompactionProvenanceEvent[],
): Pick<SessionCompactionAttentionRefs, "consumedRefs" | "ignoredRefs" | "verifyPlanRefs"> {
  const consumedRefs = new Set<string>();
  const ignoredRefs = new Set<string>();
  const verifyPlanRefs = new Set<string>();
  for (const event of events) {
    if (event.type !== ATTENTION_METRIC_EVENT_TYPE || !isRecord(event.payload)) {
      continue;
    }
    const optionRef = readAttentionOptionRefFromPayload(event.payload);
    if (!optionRef) {
      continue;
    }
    if (event.payload.metricKey === "attention.consume") {
      consumedRefs.add(optionRef);
    } else if (event.payload.metricKey === "attention.ignore") {
      ignoredRefs.add(optionRef);
    } else if (event.payload.metricKey === "attention.verify_plan") {
      verifyPlanRefs.add(optionRef);
    }
  }
  return {
    consumedRefs: [...consumedRefs],
    ignoredRefs: [...ignoredRefs],
    verifyPlanRefs: [...verifyPlanRefs],
  };
}

function readAttentionPinnedRefsFromWorkbench(
  workbenchEntries: readonly WorkbenchEntry[],
): string[] {
  const pinnedRefs = new Set<string>();
  for (const entry of workbenchEntries) {
    const retentionHint = stringOrNull((entry as ProtocolRecord).retentionHint);
    if (entry.reason !== "attention_pin" && retentionHint !== "attention_pin") {
      continue;
    }
    for (const sourceRef of entry.sourceRefs) {
      const optionRef = readAttentionOptionRef(sourceRef);
      if (optionRef) {
        pinnedRefs.add(optionRef);
      }
    }
  }
  return [...pinnedRefs];
}

function buildAttentionRefs(input: CompactionProvenanceInput): SessionCompactionAttentionRefs {
  const eventRefs = readAttentionRefsFromEvents(input.attentionEvents ?? []);
  return {
    generationIds: [],
    consumedRefs: eventRefs.consumedRefs,
    pinnedRefs: readAttentionPinnedRefsFromWorkbench(input.workbenchEntries),
    ignoredRefs: eventRefs.ignoredRefs,
    verifyPlanRefs: eventRefs.verifyPlanRefs,
  };
}

function readLatestUsedRecallStableIds(events: readonly CompactionProvenanceEvent[]): string[] {
  return events
    .filter(
      (event) =>
        event.type !== RECALL_RESULTS_SURFACED_EVENT_TYPE &&
        RECALL_USAGE_EVENT_TYPE_SET.has(event.type),
    )
    .toReversed()
    .flatMap((event) => readRecallStableIdsFromUsagePayload(event.payload));
}

function recallSelectionLimit(recallTokenBudget: number | null | undefined): number {
  if (
    typeof recallTokenBudget !== "number" ||
    !Number.isFinite(recallTokenBudget) ||
    recallTokenBudget <= 0
  ) {
    return 1;
  }
  return Math.max(
    1,
    Math.min(
      MAX_COMPACTION_RECALL_RESULT_REFS,
      Math.floor(recallTokenBudget / RECALL_RESULT_REF_TOKEN_AMORTIZATION),
    ),
  );
}

export function buildCompactionInputProvenance(
  input: CompactionProvenanceInput,
): SessionCompactionInputProvenance {
  const maxResults = recallSelectionLimit(input.recallTokenBudget);
  const eventRecallRefs = input.recallEvents.flatMap(readRecallRefsFromEvent);
  const latestProvenanceByStableId = new Map<string, SessionCompactionRecallResultRef>();
  for (const ref of eventRecallRefs) {
    latestProvenanceByStableId.set(ref.stableId, ref);
  }
  const pinnedStableIds = readRecallStableIdsFromWorkbench(input.workbenchEntries);
  const latestUsedStableIds = readLatestUsedRecallStableIds(input.usageEvents ?? []);
  const selectedStableIds = readStringArray([...pinnedStableIds, ...latestUsedStableIds])
    .filter((stableId) => latestProvenanceByStableId.has(stableId))
    .slice(0, maxResults);
  const recallResultRefs = selectedStableIds.flatMap((stableId) => {
    const ref = latestProvenanceByStableId.get(stableId);
    return ref ? [ref] : [];
  });
  const attention = buildAttentionRefs(input);
  const workbenchReferencedFiles = readFilePathsFromWorkbench(input.workbenchEntries);
  const recallFilesUsedInSummaryInput = readStringArray(
    recallResultRefs
      .map(readFilePathFromRecallRef)
      .filter((entry): entry is string => entry !== null),
  );
  const modifiedFiles = readModifiedFilesFromEvents(input.usageEvents ?? []);
  const readFiles = readStringArray([
    ...readReadFilesFromEvents(input.usageEvents ?? []),
    ...workbenchReferencedFiles,
    ...readSkillResourceFiles(input.skillSelection),
    ...recallFilesUsedInSummaryInput,
  ]);

  return {
    schema: SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V2,
    hiddenRecallSearch: false,
    activeWorkbenchEntryIds: input.workbenchEntries
      .map((entry) => stringOrNull(entry.id))
      .filter((entry): entry is string => entry !== null),
    selectedSkillInvocationIds: readSelectedSkillInvocationIds(input.skillSelection),
    surfacedResourceRefs: readSurfacedResourceRefs(input.skillSelection),
    capabilityReceiptRefs: readCapabilityReceiptRefs(input.capabilitySelection),
    recallResultRefs,
    readFiles,
    modifiedFiles,
    workbenchReferencedFiles,
    recallFilesUsedInSummaryInput,
    compactBaseline: input.compactBaseline ?? null,
    usedRecallSelection: {
      maxResults,
      selectedStableIds: recallResultRefs.map((entry) => entry.stableId),
    },
    attention,
  };
}
