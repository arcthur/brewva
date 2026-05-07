import type { JsonValue } from "@brewva/brewva-std/json";
import { asBrewvaSessionId } from "../../core/index.js";
import {
  readReasoningRevertEventPayload,
  readSessionRewindCompletedEventPayload,
} from "../../events/descriptors.js";
import {
  PATCH_RECORDED_EVENT_TYPE,
  REDO_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
  SESSION_REWIND_CHECKPOINT_RECORDED_EVENT_TYPE,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
  SESSION_REWIND_SUPERSEDED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { RedoResult } from "../patching/types.js";
import {
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
  coerceReasoningCheckpointPayload,
} from "../reasoning/api.js";
import type { ReasoningCheckpointRecord, ReasoningRevertRecord } from "../reasoning/types.js";
import type {
  SessionPromptSnapshot,
  SessionRedoRecord,
  SessionRewindCheckpointRecord,
  SessionRewindMode,
  SessionRewindRecord,
  SessionRewindState,
  SessionRewindSummary,
  SessionRewindTargetView,
  SessionRewindTrigger,
} from "../sessions/types.js";

const MAX_PROMPT_PREVIEW_CHARS = 120;

export interface SessionRewindPatchEventProjection {
  eventIndex: number;
  timestamp: number;
  checkpointEventId: string | null;
  patchSetId: string;
  changes: Array<{
    path: string;
    action: string;
  }>;
}

export interface SessionRewindPatchProjection {
  applied: {
    ids: ReadonlySet<string>;
    order: readonly string[];
  };
  patchEvents: readonly SessionRewindPatchEventProjection[];
  checkpointEventIndexes: ReadonlyMap<string, number>;
}

export interface SessionRewindPatchScopeOptions {
  activeCheckpointEventIds?: ReadonlySet<string>;
  ignoredPatchSetIds?: ReadonlySet<string>;
  onlyCurrentlyApplied?: boolean;
  patchProjection: SessionRewindPatchProjection;
}

export interface SessionRewindProjection {
  sessionId: string;
  checkpoints: SessionRewindCheckpointRecord[];
  byId: Map<string, SessionRewindCheckpointRecord>;
  latestRewind?: SessionRewindRecord;
  redoStack: SessionRedoRecord[];
  patchProjection: SessionRewindPatchProjection;
  activeReasoningCheckpointIds: readonly string[];
}

interface ReasoningProjection {
  activeLineageCheckpointIds: readonly string[];
  checkpointsById: ReadonlyMap<string, ReasoningCheckpointRecord>;
  checkpointsByEventId: ReadonlyMap<string, ReasoningCheckpointRecord>;
  revertsById: ReadonlyMap<string, ReasoningRevertRecord>;
  revertsByEventId: ReadonlyMap<string, ReasoningRevertRecord>;
}

export function buildSessionRewindCheckpointId(sequence: number): string {
  return `rewind-checkpoint-${sequence}`;
}

export function cloneSessionRewindPromptSnapshot(
  value: SessionPromptSnapshot | undefined,
): SessionPromptSnapshot | undefined {
  return value
    ? {
        text: value.text,
        parts: structuredClone(value.parts),
      }
    : undefined;
}

export function cloneSessionRewindCheckpoint(
  record: SessionRewindCheckpointRecord,
): SessionRewindCheckpointRecord {
  return {
    ...record,
    ...(record.prompt ? { prompt: cloneSessionRewindPromptSnapshot(record.prompt) } : {}),
    ...(record.supersededByEventId ? { supersededByEventId: record.supersededByEventId } : {}),
    ...(record.patchSetIds ? { patchSetIds: [...record.patchSetIds] } : {}),
  };
}

export function cloneSessionRewindRecord(record: SessionRewindRecord): SessionRewindRecord {
  return {
    ...record,
    ...(record.reasoningRevert ? { reasoningRevert: structuredClone(record.reasoningRevert) } : {}),
    ...(record.divergenceNote ? { divergenceNote: structuredClone(record.divergenceNote) } : {}),
    abandonedCheckpointIds: [...record.abandonedCheckpointIds],
    patchSetIds: [...record.patchSetIds],
    rollbackResults: structuredClone(record.rollbackResults),
  };
}

export function cloneSessionRedoRecord(record: SessionRedoRecord): SessionRedoRecord {
  return {
    ...record,
    patchSetIds: [...record.patchSetIds],
    redoResults: structuredClone(record.redoResults),
    ...(record.reasoningCheckpoint
      ? { reasoningCheckpoint: structuredClone(record.reasoningCheckpoint) }
      : {}),
  };
}

export function buildSessionRewindProjection(input: {
  sessionId: string;
  events: readonly BrewvaEventRecord[];
  activeReasoningCheckpointIds?: readonly string[];
}): SessionRewindProjection {
  const reasoningProjection = buildReasoningProjection(input.sessionId, input.events);
  const activeReasoningCheckpointIds =
    input.activeReasoningCheckpointIds ?? reasoningProjection.activeLineageCheckpointIds;
  const projection: SessionRewindProjection = {
    sessionId: input.sessionId,
    checkpoints: [],
    byId: new Map(),
    redoStack: [],
    patchProjection: buildSessionRewindPatchProjection(input.events),
    activeReasoningCheckpointIds,
  };

  for (const event of input.events) {
    if (event.type === SESSION_REWIND_CHECKPOINT_RECORDED_EVENT_TYPE) {
      const checkpoint = readCheckpointPayload(event);
      if (!checkpoint || projection.byId.has(checkpoint.checkpointId)) {
        continue;
      }
      projection.byId.set(checkpoint.checkpointId, checkpoint);
      projection.checkpoints.push(checkpoint);
      continue;
    }

    if (event.type === SESSION_REWIND_COMPLETED_EVENT_TYPE) {
      const rewind = readSuccessfulRewindPayload(event, reasoningProjection);
      if (!rewind) {
        continue;
      }
      const checkpoint = projection.byId.get(rewind.checkpointId);
      if (checkpoint) {
        checkpoint.undoneAt = event.timestamp;
        checkpoint.redoneAt = undefined;
        checkpoint.patchSetIds = [...rewind.patchSetIds];
        checkpoint.returnLeafEntryId = rewind.returnLeafEntryId;
      }
      for (const abandonedCheckpointId of rewind.abandonedCheckpointIds) {
        const abandonedCheckpoint = projection.byId.get(abandonedCheckpointId);
        if (!abandonedCheckpoint) {
          continue;
        }
        abandonedCheckpoint.supersededAt = event.timestamp;
        abandonedCheckpoint.supersededByEventId = event.id;
      }
      projection.latestRewind = rewind;
      projection.redoStack.push({
        eventId: rewind.eventId,
        timestamp: rewind.timestamp,
        checkpointId: rewind.checkpointId,
        mode: rewind.mode,
        patchSetIds: [...rewind.patchSetIds],
        redoResults: [],
        returnLeafEntryId: rewind.returnLeafEntryId,
      });
      continue;
    }

    if (event.type === SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE) {
      const priorMode = projection.redoStack.at(-1)?.mode ?? "both";
      const redo = readSuccessfulRedoPayload(event, reasoningProjection, priorMode);
      if (!redo) {
        continue;
      }
      const checkpoint = projection.byId.get(redo.checkpointId);
      if (checkpoint) {
        checkpoint.redoneAt = event.timestamp;
        checkpoint.patchSetIds = [...redo.patchSetIds];
        checkpoint.returnLeafEntryId = redo.returnLeafEntryId;
      }
      if (
        projection.redoStack.length > 0 &&
        projection.redoStack.at(-1)?.checkpointId === redo.checkpointId
      ) {
        projection.redoStack.pop();
      } else {
        projection.redoStack = projection.redoStack.filter(
          (entry) => entry.checkpointId !== redo.checkpointId,
        );
      }
      continue;
    }

    if (event.type === SESSION_REWIND_SUPERSEDED_EVENT_TYPE) {
      const checkpointIds = readStringArray(event.payload?.checkpointIds);
      if (checkpointIds.length === 0) {
        projection.redoStack = [];
        continue;
      }
      const superseded = new Set(checkpointIds);
      projection.redoStack = projection.redoStack.filter(
        (entry) => !superseded.has(entry.checkpointId),
      );
      for (const checkpointId of checkpointIds) {
        const checkpoint = projection.byId.get(checkpointId);
        if (checkpoint) {
          checkpoint.supersededAt = event.timestamp;
          checkpoint.supersededByEventId = event.id;
        }
      }
    }
  }

  applyCheckpointStatuses(projection);
  return projection;
}

export function buildSessionRewindState(projection: SessionRewindProjection): SessionRewindState {
  const activeReasoningCheckpointIds = new Set(projection.activeReasoningCheckpointIds);
  const redoCheckpointIds = new Set(projection.redoStack.map((entry) => entry.checkpointId));
  const checkpoints = projection.checkpoints.map((checkpoint) =>
    cloneSessionRewindCheckpoint(checkpoint),
  );
  const latestRewindable = checkpoints
    .toReversed()
    .find((checkpoint) =>
      isSessionRewindCheckpointSelectable(activeReasoningCheckpointIds, checkpoint),
    );
  const nextRedoable = projection.redoStack.length
    ? checkpoints.find(
        (checkpoint) => checkpoint.checkpointId === projection.redoStack.at(-1)?.checkpointId,
      )
    : undefined;
  return {
    checkpoints,
    rewindAvailable: Boolean(latestRewindable),
    redoAvailable: redoCheckpointIds.size > 0,
    ...(latestRewindable ? { latestRewindable } : {}),
    ...(nextRedoable ? { nextRedoable } : {}),
    ...(projection.latestRewind
      ? { latestRewind: cloneSessionRewindRecord(projection.latestRewind) }
      : {}),
    redoStack: projection.redoStack.map((entry) => cloneSessionRedoRecord(entry)),
  };
}

export function listSessionRewindTargets(
  projection: SessionRewindProjection,
): SessionRewindTargetView[] {
  const activeReasoningCheckpointIds = new Set(projection.activeReasoningCheckpointIds);
  const activeCheckpointEventIds = collectSessionRewindActiveCheckpointEventIds(
    projection.checkpoints,
    activeReasoningCheckpointIds,
  );
  const ignoredPatchSetIds = new Set(projection.redoStack.flatMap((entry) => entry.patchSetIds));
  const latestRewind = projection.latestRewind;

  return projection.checkpoints
    .map((checkpoint) => {
      const scope: SessionRewindPatchScopeOptions =
        checkpoint.status === "active" || checkpoint.status === "redone"
          ? {
              activeCheckpointEventIds,
              ignoredPatchSetIds,
              onlyCurrentlyApplied: true,
              patchProjection: projection.patchProjection,
            }
          : {
              ignoredPatchSetIds,
              patchProjection: projection.patchProjection,
            };
      const patchSetIds = listSessionRewindPatchSetIdsAfterCheckpoint(checkpoint, scope);
      return {
        checkpointId: checkpoint.checkpointId,
        turn: checkpoint.turn,
        timestamp: checkpoint.timestamp,
        promptPreview: buildPromptPreview(checkpoint.prompt),
        patchSetCountAfter: patchSetIds.length,
        fileSummary: summarizeSessionRewindPatchFileChanges(
          patchSetIds,
          projection.patchProjection,
        ),
        lineage:
          checkpoint.status === "superseded"
            ? {
                kind: "abandoned",
                rewoundBy:
                  checkpoint.supersededByEventId ?? latestRewind?.eventId ?? checkpoint.eventId,
                rewoundAt:
                  checkpoint.supersededAt ?? latestRewind?.timestamp ?? checkpoint.timestamp,
              }
            : { kind: "active" },
      } satisfies SessionRewindTargetView;
    })
    .toSorted(
      (left, right) =>
        right.timestamp - left.timestamp || right.checkpointId.localeCompare(left.checkpointId),
    );
}

export function isSessionRewindCheckpointActive(
  activeReasoningCheckpointIds: ReadonlySet<string>,
  checkpoint: SessionRewindCheckpointRecord,
): boolean {
  return activeReasoningCheckpointIds.has(checkpoint.reasoningCheckpointId);
}

export function isSessionRewindCheckpointSelectable(
  activeReasoningCheckpointIds: ReadonlySet<string>,
  checkpoint: SessionRewindCheckpointRecord,
): boolean {
  return (
    checkpoint.status !== "undone" &&
    isSessionRewindCheckpointActive(activeReasoningCheckpointIds, checkpoint)
  );
}

export function collectSessionRewindAbandonedCheckpointIds(
  checkpoints: readonly SessionRewindCheckpointRecord[],
  activeReasoningCheckpointIds: readonly string[],
  targetReasoningCheckpointId: string,
): string[] {
  const targetIndex = activeReasoningCheckpointIds.indexOf(targetReasoningCheckpointId);
  if (targetIndex < 0) {
    return [];
  }
  const abandonedReasoningCheckpointIds = new Set(
    activeReasoningCheckpointIds.slice(targetIndex + 1),
  );
  return checkpoints
    .filter((checkpoint) => abandonedReasoningCheckpointIds.has(checkpoint.reasoningCheckpointId))
    .map((checkpoint) => checkpoint.checkpointId);
}

export function collectSessionRewindActiveCheckpointEventIds(
  checkpoints: readonly SessionRewindCheckpointRecord[],
  activeReasoningCheckpointIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const activeCheckpointEventIds = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (activeReasoningCheckpointIds.has(checkpoint.reasoningCheckpointId)) {
      activeCheckpointEventIds.add(checkpoint.eventId);
    }
  }
  return activeCheckpointEventIds;
}

export function listSessionRewindPatchSetIdsAfterCheckpoint(
  checkpoint: SessionRewindCheckpointRecord,
  options: SessionRewindPatchScopeOptions,
): string[] {
  const checkpointIndex = options.patchProjection.checkpointEventIndexes.get(checkpoint.eventId);
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const patchEvent of options.patchProjection.patchEvents) {
    const isAfterCheckpoint =
      checkpointIndex === undefined
        ? patchEvent.timestamp >= checkpoint.timestamp
        : patchEvent.eventIndex > checkpointIndex;
    if (!isAfterCheckpoint || seen.has(patchEvent.patchSetId)) {
      continue;
    }
    if (options.ignoredPatchSetIds?.has(patchEvent.patchSetId)) {
      continue;
    }
    if (
      options.activeCheckpointEventIds &&
      (!patchEvent.checkpointEventId ||
        !options.activeCheckpointEventIds.has(patchEvent.checkpointEventId))
    ) {
      continue;
    }
    if (
      options.onlyCurrentlyApplied &&
      !options.patchProjection.applied.ids.has(patchEvent.patchSetId)
    ) {
      continue;
    }
    seen.add(patchEvent.patchSetId);
    candidates.push(patchEvent.patchSetId);
  }

  if (!options.onlyCurrentlyApplied) {
    return candidates;
  }
  const candidateSet = new Set(candidates);
  return options.patchProjection.applied.order.filter((patchSetId) => candidateSet.has(patchSetId));
}

export function summarizeSessionRewindPatchFileChanges(
  patchSetIds: readonly string[],
  patchProjection: SessionRewindPatchProjection,
): SessionRewindTargetView["fileSummary"] {
  const includedPatchSetIds = new Set(patchSetIds);
  const seen = new Set<string>();
  const summary = { added: 0, modified: 0, deleted: 0 };
  for (const patchEvent of patchProjection.patchEvents) {
    if (!includedPatchSetIds.has(patchEvent.patchSetId)) {
      continue;
    }
    for (const change of patchEvent.changes) {
      const key = `${patchEvent.patchSetId}:${change.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (change.action === "add") {
        summary.added += 1;
      } else if (change.action === "modify") {
        summary.modified += 1;
      } else if (change.action === "delete") {
        summary.deleted += 1;
      }
    }
  }
  return summary;
}

function applyCheckpointStatuses(projection: SessionRewindProjection): void {
  const activeReasoningCheckpointIds = new Set(projection.activeReasoningCheckpointIds);
  const redoCheckpointIds = new Set(projection.redoStack.map((entry) => entry.checkpointId));
  for (const checkpoint of projection.checkpoints) {
    if (redoCheckpointIds.has(checkpoint.checkpointId)) {
      checkpoint.status = "undone";
    } else if (
      typeof checkpoint.redoneAt === "number" &&
      checkpoint.redoneAt >= (checkpoint.undoneAt ?? Number.NEGATIVE_INFINITY)
    ) {
      checkpoint.status = "redone";
    } else if (isSessionRewindCheckpointActive(activeReasoningCheckpointIds, checkpoint)) {
      checkpoint.status = "active";
    } else {
      checkpoint.status = "superseded";
    }
    if (checkpoint.status !== "superseded") {
      delete checkpoint.supersededAt;
      delete checkpoint.supersededByEventId;
    }
  }
}

function buildReasoningProjection(
  sessionId: string,
  events: readonly BrewvaEventRecord[],
): ReasoningProjection {
  let nextCheckpointSequence = 1;
  let nextBranchSequence = 1;
  let nextRevertSequence = 1;
  const rootBranchId = `${sessionId}:reasoning-branch-0`;
  let activeBranchId = rootBranchId;
  let activeBranchSequence = 0;
  let activeCheckpointId: string | null = null;
  let activeLineageCheckpointIds: string[] = [];
  const recordedRevertIds = new Set<string>();
  const recordedBranchIds = new Set<string>([rootBranchId]);
  const acceptedCheckpointsById = new Map<
    string,
    {
      checkpointId: string;
      parentCheckpointId: string | null;
      branchId: string;
    }
  >();
  const lineageByCheckpointId = new Map<string, string[]>();
  const checkpointsById = new Map<string, ReasoningCheckpointRecord>();
  const checkpointsByEventId = new Map<string, ReasoningCheckpointRecord>();
  const revertsById = new Map<string, ReasoningRevertRecord>();
  const revertsByEventId = new Map<string, ReasoningRevertRecord>();

  for (const event of events) {
    if (event.type === REASONING_CHECKPOINT_EVENT_TYPE) {
      const checkpoint = readReasoningCheckpoint(event);
      if (!checkpoint) {
        continue;
      }
      checkpointsById.set(checkpoint.checkpointId, checkpoint);
      checkpointsByEventId.set(checkpoint.eventId, checkpoint);
      const parentCheckpointId = checkpoint.parentCheckpointId;
      if (
        acceptedCheckpointsById.has(checkpoint.checkpointId) ||
        checkpoint.checkpointSequence < nextCheckpointSequence ||
        checkpoint.branchId !== activeBranchId ||
        checkpoint.branchSequence !== activeBranchSequence ||
        parentCheckpointId !== activeCheckpointId
      ) {
        continue;
      }
      activeLineageCheckpointIds.push(checkpoint.checkpointId);
      lineageByCheckpointId.set(checkpoint.checkpointId, [...activeLineageCheckpointIds]);
      acceptedCheckpointsById.set(checkpoint.checkpointId, {
        checkpointId: checkpoint.checkpointId,
        parentCheckpointId,
        branchId: checkpoint.branchId,
      });
      activeCheckpointId = checkpoint.checkpointId;
      activeBranchSequence = checkpoint.branchSequence;
      nextCheckpointSequence = Math.max(nextCheckpointSequence, checkpoint.checkpointSequence + 1);
      nextBranchSequence = Math.max(nextBranchSequence, checkpoint.branchSequence + 1);
      continue;
    }

    if (event.type === REASONING_REVERT_EVENT_TYPE) {
      const revert = readReasoningRevert(event);
      if (!revert) {
        continue;
      }
      revertsById.set(revert.revertId, revert);
      revertsByEventId.set(revert.eventId, revert);
      const targetCheckpoint = acceptedCheckpointsById.get(revert.toCheckpointId);
      if (
        !targetCheckpoint ||
        recordedRevertIds.has(revert.revertId) ||
        revert.revertSequence < nextRevertSequence ||
        revert.newBranchSequence < nextBranchSequence ||
        revert.fromBranchId !== activeBranchId ||
        revert.fromCheckpointId !== activeCheckpointId ||
        !activeLineageCheckpointIds.includes(revert.toCheckpointId) ||
        recordedBranchIds.has(revert.newBranchId)
      ) {
        continue;
      }
      recordedRevertIds.add(revert.revertId);
      recordedBranchIds.add(revert.newBranchId);
      activeBranchId = revert.newBranchId;
      activeBranchSequence = revert.newBranchSequence;
      activeCheckpointId = revert.toCheckpointId;
      activeLineageCheckpointIds = [...(lineageByCheckpointId.get(revert.toCheckpointId) ?? [])];
      nextRevertSequence = Math.max(nextRevertSequence, revert.revertSequence + 1);
      nextBranchSequence = Math.max(nextBranchSequence, revert.newBranchSequence + 1);
    }
  }

  return {
    activeLineageCheckpointIds,
    checkpointsById,
    checkpointsByEventId,
    revertsById,
    revertsByEventId,
  };
}

function buildSessionRewindPatchProjection(
  events: readonly BrewvaEventRecord[],
): SessionRewindPatchProjection {
  const appliedPatchSetIds = new Set<string>();
  const appliedPatchSetOrder: string[] = [];
  const patchEvents: SessionRewindPatchEventProjection[] = [];
  const checkpointEventIndexes = new Map<string, number>();
  let currentCheckpointEventId: string | null = null;

  for (const [eventIndex, event] of events.entries()) {
    if (event.type === SESSION_REWIND_CHECKPOINT_RECORDED_EVENT_TYPE) {
      currentCheckpointEventId = event.id;
      checkpointEventIndexes.set(event.id, eventIndex);
      continue;
    }

    if (event.type === PATCH_RECORDED_EVENT_TYPE) {
      const patchSetId = normalizeOptionalString(event.payload?.patchSetId);
      if (!patchSetId || event.payload?.applyStatus === "failed") {
        continue;
      }
      addAppliedPatchSet(appliedPatchSetIds, appliedPatchSetOrder, patchSetId);
      patchEvents.push({
        eventIndex,
        timestamp: event.timestamp,
        checkpointEventId: currentCheckpointEventId,
        patchSetId,
        changes: readPatchEventChanges(event.payload?.changes),
      });
      continue;
    }

    if (event.type === ROLLBACK_EVENT_TYPE && event.payload?.ok === true) {
      const patchSetId = normalizeOptionalString(event.payload.patchSetId);
      if (patchSetId) {
        removeAppliedPatchSet(appliedPatchSetIds, appliedPatchSetOrder, patchSetId);
      }
      continue;
    }

    if (event.type === REDO_EVENT_TYPE && event.payload?.ok === true) {
      const patchSetId = normalizeOptionalString(event.payload.patchSetId);
      if (patchSetId) {
        addAppliedPatchSet(appliedPatchSetIds, appliedPatchSetOrder, patchSetId);
      }
    }
  }

  return {
    applied: {
      ids: appliedPatchSetIds,
      order: appliedPatchSetOrder,
    },
    patchEvents,
    checkpointEventIndexes,
  };
}

function readCheckpointPayload(
  event: BrewvaEventRecord,
): SessionRewindCheckpointRecord | undefined {
  const payload = event.payload;
  const checkpointId = normalizeOptionalString(payload?.checkpointId);
  const turnId = normalizeOptionalString(payload?.turnId);
  const reasoningCheckpointId = normalizeOptionalString(payload?.reasoningCheckpointId);
  if (!checkpointId || !turnId || !reasoningCheckpointId) {
    return undefined;
  }
  return {
    checkpointId,
    sessionId: asBrewvaSessionId(event.sessionId),
    turnId,
    reasoningCheckpointId,
    leafEntryId: normalizeNullableString(payload?.leafEntryId),
    prompt: normalizePromptSnapshot(payload?.prompt),
    turn: normalizeTurn(event.turn),
    eventId: event.id,
    timestamp: event.timestamp,
    status: "active",
  };
}

function readSuccessfulRewindPayload(
  event: BrewvaEventRecord,
  reasoningProjection: ReasoningProjection,
): SessionRewindRecord | undefined {
  const payload = readSessionRewindCompletedEventPayload(event);
  if (!payload || !payload.ok) {
    return undefined;
  }
  const checkpointId = normalizeOptionalString(payload.checkpointId);
  const trigger = normalizeTrigger(payload.trigger);
  if (!checkpointId || !trigger) {
    return undefined;
  }
  const reasoningRevert = resolveReasoningRevert(payload, reasoningProjection);
  return {
    eventId: event.id,
    timestamp: event.timestamp,
    checkpointId,
    trigger,
    mode: normalizeMode(payload.mode, "both"),
    summary: normalizeSummary(payload.summary, trigger === "undo" ? "carry" : "none"),
    ...(reasoningRevert ? { reasoningRevert } : {}),
    ...(payload.divergenceNote ? { divergenceNote: structuredClone(payload.divergenceNote) } : {}),
    abandonedCheckpointIds: [...payload.abandonedCheckpointIds],
    patchSetIds: [...payload.patchSetIds],
    rollbackResults: structuredClone(payload.rollbackResults),
    returnLeafEntryId: payload.returnLeafEntryId,
  };
}

function readSuccessfulRedoPayload(
  event: BrewvaEventRecord,
  reasoningProjection: ReasoningProjection,
  defaultMode: SessionRewindMode,
): SessionRedoRecord | undefined {
  const payload = event.payload;
  if (payload?.ok !== true) {
    return undefined;
  }
  const checkpointId = normalizeOptionalString(payload.checkpointId);
  if (!checkpointId) {
    return undefined;
  }
  const reasoningCheckpoint = resolveReasoningCheckpoint(payload, reasoningProjection);
  return {
    eventId: event.id,
    timestamp: event.timestamp,
    checkpointId,
    mode: normalizeMode(payload.mode, defaultMode),
    patchSetIds: readStringArray(payload.patchSetIds),
    redoResults: readRedoResults(payload.redoResults),
    returnLeafEntryId: normalizeNullableString(payload.returnLeafEntryId),
    ...(reasoningCheckpoint ? { reasoningCheckpoint } : {}),
  };
}

function resolveReasoningRevert(
  payload:
    | {
        reasoningRevertEventId?: string | null;
        reasoningRevertId?: string | null;
      }
    | undefined,
  reasoningProjection: ReasoningProjection,
): ReasoningRevertRecord | undefined {
  const eventId = normalizeOptionalString(payload?.reasoningRevertEventId);
  if (eventId) {
    return reasoningProjection.revertsByEventId.get(eventId);
  }
  const revertId = normalizeOptionalString(payload?.reasoningRevertId);
  return revertId ? reasoningProjection.revertsById.get(revertId) : undefined;
}

function resolveReasoningCheckpoint(
  payload: Record<string, JsonValue> | undefined,
  reasoningProjection: ReasoningProjection,
): ReasoningCheckpointRecord | undefined {
  const eventId = normalizeOptionalString(payload?.reasoningCheckpointEventId);
  if (eventId) {
    return reasoningProjection.checkpointsByEventId.get(eventId);
  }
  const checkpointId = normalizeOptionalString(payload?.reasoningCheckpointId);
  return checkpointId ? reasoningProjection.checkpointsById.get(checkpointId) : undefined;
}

function readReasoningCheckpoint(event: BrewvaEventRecord): ReasoningCheckpointRecord | undefined {
  const payload = coerceReasoningCheckpointPayload(event.payload);
  if (!payload) {
    return undefined;
  }
  return {
    checkpointId: payload.checkpointId,
    checkpointSequence: payload.checkpointSequence,
    branchId: payload.branchId,
    branchSequence: payload.branchSequence,
    parentCheckpointId: payload.parentCheckpointId ?? null,
    boundary: payload.boundary,
    leafEntryId: payload.leafEntryId ?? null,
    turn: normalizeTurn(event.turn),
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

function readReasoningRevert(event: BrewvaEventRecord): ReasoningRevertRecord | undefined {
  const payload = readReasoningRevertEventPayload(event);
  if (!payload) {
    return undefined;
  }
  return {
    revertId: payload.revertId,
    revertSequence: payload.revertSequence,
    toCheckpointId: payload.toCheckpointId,
    fromCheckpointId: payload.fromCheckpointId ?? null,
    fromBranchId: payload.fromBranchId,
    newBranchId: payload.newBranchId,
    newBranchSequence: payload.newBranchSequence,
    trigger: payload.trigger,
    continuityPacket: structuredClone(payload.continuityPacket),
    linkedRollbackReceiptIds: [...(payload.linkedRollbackReceiptIds ?? [])],
    targetLeafEntryId: payload.targetLeafEntryId ?? null,
    turn: normalizeTurn(event.turn),
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

function readPatchEventChanges(value: unknown): SessionRewindPatchEventProjection["changes"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const changes: SessionRewindPatchEventProjection["changes"] = [];
  for (const change of value) {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      continue;
    }
    const record = change as Record<string, unknown>;
    const path = normalizeOptionalString(record.path);
    const action = normalizeOptionalString(record.action);
    if (path && action) {
      changes.push({ path, action });
    }
  }
  return changes;
}

function addAppliedPatchSet(
  appliedPatchSetIds: Set<string>,
  appliedPatchSetOrder: string[],
  patchSetId: string,
): void {
  if (appliedPatchSetIds.has(patchSetId)) {
    const currentIndex = appliedPatchSetOrder.indexOf(patchSetId);
    if (currentIndex >= 0) {
      appliedPatchSetOrder.splice(currentIndex, 1);
    }
  }
  appliedPatchSetIds.add(patchSetId);
  appliedPatchSetOrder.push(patchSetId);
}

function removeAppliedPatchSet(
  appliedPatchSetIds: Set<string>,
  appliedPatchSetOrder: string[],
  patchSetId: string,
): void {
  if (!appliedPatchSetIds.delete(patchSetId)) {
    return;
  }
  const currentIndex = appliedPatchSetOrder.indexOf(patchSetId);
  if (currentIndex >= 0) {
    appliedPatchSetOrder.splice(currentIndex, 1);
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return normalizeOptionalString(value) ?? null;
}

function normalizeTurn(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeMode(value: unknown, fallback: SessionRewindMode): SessionRewindMode {
  return value === "conversation" || value === "code" || value === "both" ? value : fallback;
}

function normalizeSummary(value: unknown, fallback: SessionRewindSummary): SessionRewindSummary {
  return value === "none" || value === "carry" ? value : fallback;
}

function normalizeTrigger(value: unknown): SessionRewindTrigger | undefined {
  return value === "undo" || value === "rewind" ? value : undefined;
}

function normalizePromptSnapshot(value: unknown): SessionPromptSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") {
    return undefined;
  }
  const parts = Array.isArray(record.parts) ? (record.parts as JsonValue[]) : [];
  return {
    text: record.text,
    parts: structuredClone(parts),
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of value) {
    const normalized = normalizeOptionalString(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function readRedoResults(value: unknown): RedoResult[] {
  return Array.isArray(value) ? (structuredClone(value) as RedoResult[]) : [];
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function buildPromptPreview(prompt: SessionPromptSnapshot | undefined): string {
  const compact = compactWhitespace(prompt?.text ?? "");
  if (compact.length <= MAX_PROMPT_PREVIEW_CHARS) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, MAX_PROMPT_PREVIEW_CHARS - 3))}...`;
}
