import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V1,
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
  readonly compactBaseline?: unknown;
  readonly recallTokenBudget?: number | null;
}

const RECALL_SOURCE_FAMILIES = ["tape_evidence", "repository_precedent"] as const;
const RECALL_SESSION_SCOPES = ["current_session", "prior_session", "cross_workspace"] as const;
const RECALL_STABLE_ID_PATTERN = /\b(?:tape:[^\s'",\]}]+|precedent:[^\s'",\]}]+)/gu;
export const RECALL_USAGE_EVENT_TYPES = [
  "tool.invocation.started",
  "tool.result.recorded",
  "tool_call_observed",
  "tool_call_started",
  "tool_call_ended",
] as const;
const RECALL_USAGE_EVENT_TYPE_SET = new Set<string>(RECALL_USAGE_EVENT_TYPES);
const MAX_COMPACTION_RECALL_RESULT_REFS = 8;

// One used recall ref is budgeted as a compact provenance pointer plus its projected summary.
const RECALL_RESULT_REF_TOKEN_AMORTIZATION = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecallSourceFamily(
  value: unknown,
): SessionCompactionRecallResultRef["sourceFamily"] | null {
  const normalized = readString(value);
  return normalized && (RECALL_SOURCE_FAMILIES as readonly string[]).includes(normalized)
    ? (normalized as SessionCompactionRecallResultRef["sourceFamily"])
    : null;
}

function readRecallSessionScope(
  value: unknown,
): SessionCompactionRecallResultRef["sessionScope"] | null {
  const normalized = readString(value);
  return normalized && (RECALL_SESSION_SCOPES as readonly string[]).includes(normalized)
    ? (normalized as SessionCompactionRecallResultRef["sessionScope"])
    : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.map((entry) => readString(entry)).filter((entry): entry is string => entry !== null),
    ),
  ];
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
    .map((record) => readString(record.invocationId))
    .filter((entry): entry is string => entry !== null);
}

function readResourceRef(value: unknown): SessionCompactionResourceRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = readString(value.kind);
  const path = readString(value.path);
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

function readCapabilityReceiptRefs(capabilitySelection: unknown): string[] {
  if (!isRecord(capabilitySelection)) {
    return [];
  }
  const selectionId = readString(capabilitySelection.selectionId);
  if (selectionId) {
    return [selectionId];
  }
  return readStringArray(capabilitySelection.selectedCapabilities);
}

function readRecallResultRef(value: unknown): SessionCompactionRecallResultRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const stableId = readString(value.stableId);
  const sourceFamily = readRecallSourceFamily(value.sourceFamily);
  const sessionScope = readRecallSessionScope(value.sessionScope);
  const rootRef = readString(value.rootRef);
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
  const stableId = readString(value);
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

  return {
    schema: SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V1,
    hiddenRecallSearch: false,
    activeWorkbenchEntryIds: input.workbenchEntries
      .map((entry) => readString(entry.id))
      .filter((entry): entry is string => entry !== null),
    selectedSkillInvocationIds: readSelectedSkillInvocationIds(input.skillSelection),
    surfacedResourceRefs: readSurfacedResourceRefs(input.skillSelection),
    capabilityReceiptRefs: readCapabilityReceiptRefs(input.capabilitySelection),
    recallResultRefs,
    compactBaseline: input.compactBaseline ?? null,
    usedRecallSelection: {
      maxResults,
      selectedStableIds: recallResultRefs.map((entry) => entry.stableId),
    },
  };
}
