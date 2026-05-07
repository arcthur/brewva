import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaEventStore } from "../../events/store.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeRecordEvent } from "./event-pipeline.js";
import {
  CAPABILITY_STATE_RECORDED_EVENT_TYPE,
  CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
  SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
  SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
} from "./events.js";
import {
  readCapabilityStateRecordedEventPayload,
  readContextEntryRecordedEventPayload,
  readSessionLineageNodeCreatedEventPayload,
  readSessionLineageOutcomeAdoptedEventPayload,
  readSessionLineageOutcomeRecordedEventPayload,
  readSessionLineageSelectionRecordedEventPayload,
  readSessionLineageSummaryRecordedEventPayload,
} from "./lineage-event-descriptors.js";

export type ContextAdmission = "state_only" | "context_eligible" | "context_required";
export type ContextEntryPresentTo = "llm" | "ui" | "both";
export type LineageOutcomeAdmission = Exclude<ContextAdmission, "context_required">;

export const CAPABILITY_STATE_INLINE_DATA_MAX_BYTES = 16 * 1024;

export type ForkPoint =
  | { kind: "session_root"; parentSessionId?: string }
  | { kind: "reasoning_checkpoint"; reasoningCheckpointId: string }
  | { kind: "turn"; turnId: string }
  | { kind: "context_entry"; lineageNodeId: string; entryId: string }
  | { kind: "tool_call"; toolCallId: string }
  | { kind: "patch_set"; patchSetId: string }
  | { kind: "worker_run"; workerRunId: string };

export type SessionLineageNodeKind = string;

export interface SessionLineageNodeCreatedPayload {
  schema: typeof SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE;
  lineageNodeId: string;
  parentLineageNodeId: string | null;
  kind: SessionLineageNodeKind;
  forkPoint: ForkPoint;
  title?: string;
  createdBy?: string;
}

export interface SessionLineageSummaryRecordedPayload {
  schema: typeof SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE;
  summaryId: string;
  lineageNodeId: string;
  attachToEntryId: string | null;
  summary: string;
  admission: ContextAdmission;
  detailsArtifactRef?: string;
}

export interface SessionLineageOutcomeRecordedPayload {
  schema: typeof SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE;
  outcomeId: string;
  lineageNodeId: string;
  summary: string;
  admission: LineageOutcomeAdmission;
  outcomeRef?: string;
  detailsArtifactRef?: string;
}

export interface SessionLineageOutcomeAdoptedPayload {
  schema: typeof SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE;
  adoptionId: string;
  outcomeId: string;
  fromLineageNodeId: string;
  toLineageNodeId: string;
  admission: ContextAdmission;
  summary?: string;
  adoptedEntryId?: string;
}

export interface SessionLineageSelectionRecordedPayload {
  schema: typeof SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE;
  selectionId: string;
  channelId: string;
  lineageNodeId: string;
  previousLineageNodeId?: string;
  reason?: string;
}

export interface ContextEntryRecordedPayload {
  schema: typeof CONTEXT_ENTRY_RECORDED_EVENT_TYPE;
  entryId: string;
  lineageNodeId: string;
  parentEntryId: string | null;
  sourceEventId: string;
  sourceEventType: string;
  entryKind: string;
  admission: ContextAdmission;
  presentTo: ContextEntryPresentTo;
  attachToEntryId?: string | null;
  contentRef?: string;
}

export interface CapabilityStateRecordedPayload {
  schema: typeof CAPABILITY_STATE_RECORDED_EVENT_TYPE;
  stateId: string;
  ownerCapability: string;
  customType: string;
  data: Record<string, JsonValue>;
  artifactRef?: string;
  lineageNodeId?: string;
  entryId?: string;
}

export type CreateSessionLineageNodeInput = Omit<
  SessionLineageNodeCreatedPayload,
  "schema" | "parentLineageNodeId"
> & {
  parentLineageNodeId?: string | null;
};

export type RecordSessionLineageSummaryInput = Omit<
  SessionLineageSummaryRecordedPayload,
  "schema" | "attachToEntryId"
> & {
  attachToEntryId?: string | null;
};

export type RecordSessionLineageOutcomeInput = Omit<
  SessionLineageOutcomeRecordedPayload,
  "schema" | "admission"
> & {
  admission?: LineageOutcomeAdmission;
};

export type AdoptSessionLineageOutcomeInput = Omit<SessionLineageOutcomeAdoptedPayload, "schema">;
export type RecordSessionLineageSelectionInput = Omit<
  SessionLineageSelectionRecordedPayload,
  "schema"
>;

export type RecordContextEntryInput = Omit<ContextEntryRecordedPayload, "schema">;
export type RecordCapabilityStateInput = Omit<CapabilityStateRecordedPayload, "schema">;

export interface SessionLineageNodeRecord extends SessionLineageNodeCreatedPayload {
  eventId: string;
  timestamp: number;
}

export interface SessionLineageSummaryRecord extends SessionLineageSummaryRecordedPayload {
  eventId: string;
  timestamp: number;
}

export interface SessionLineageOutcomeRecord extends SessionLineageOutcomeRecordedPayload {
  eventId: string;
  timestamp: number;
}

export interface SessionLineageOutcomeAdoptionRecord extends SessionLineageOutcomeAdoptedPayload {
  eventId: string;
  timestamp: number;
}

export interface SessionLineageSelectionRecord extends SessionLineageSelectionRecordedPayload {
  eventId: string;
  timestamp: number;
}

export interface ContextEntryRecord extends ContextEntryRecordedPayload {
  eventId: string;
  timestamp: number;
}

export interface CapabilityStateRecord extends CapabilityStateRecordedPayload {
  eventId: string;
  timestamp: number;
}

export interface SessionLineageNodeView extends SessionLineageNodeRecord {
  summaries: SessionLineageSummaryRecord[];
  outcomes: SessionLineageOutcomeRecord[];
  adoptedOutcomes: SessionLineageOutcomeAdoptionRecord[];
}

export interface SessionLineageEdge {
  parentLineageNodeId: string;
  childLineageNodeId: string;
}

export interface SessionLineageTree {
  sessionId: string;
  rootNodeId: string;
  nodes: SessionLineageNodeView[];
  edges: SessionLineageEdge[];
  selectedByChannel: Record<string, string>;
}

export interface SessionLineageState {
  nodes: Map<string, SessionLineageNodeRecord>;
  childrenByParent: Map<string, string[]>;
  summariesByNode: Map<string, SessionLineageSummaryRecord[]>;
  outcomesByNode: Map<string, SessionLineageOutcomeRecord[]>;
  outcomesById: Map<string, SessionLineageOutcomeRecord>;
  adoptedOutcomesByNode: Map<string, SessionLineageOutcomeAdoptionRecord[]>;
  selectionsByChannel: Map<string, SessionLineageSelectionRecord>;
  contextEntries: Map<string, ContextEntryRecord>;
  contextEntriesByNode: Map<string, ContextEntryRecord[]>;
  capabilityStates: CapabilityStateRecord[];
}

export interface GetContextEntryPathInput {
  /**
   * Ambiguous targets resolve to the last appended context entry for the
   * requested lineage node, or the last appended session context entry when no
   * lineage node is supplied.
   */
  lineageNodeId?: string;
  entryId?: string;
  includeStateOnly?: boolean;
}

export interface SessionLineageServiceOptions {
  eventStore: BrewvaEventStore;
  recordEvent: RuntimeRecordEvent;
  isCapabilityStateOwnerDeclared: (this: void, ownerCapability: string) => boolean;
  maxInlineCapabilityStateBytes?: number;
}

function clonePayload<T>(value: T): T {
  return structuredClone(value);
}

function requireRecordedEvent(
  event: BrewvaEventRecord | undefined,
  type: string,
): BrewvaEventRecord {
  if (!event) {
    throw new Error(`session_lineage_event_not_recorded:${type}`);
  }
  return event;
}

function appendMapList<TKey, TValue>(map: Map<TKey, TValue[]>, key: TKey, value: TValue): void {
  const entries = map.get(key);
  if (entries) {
    entries.push(value);
    return;
  }
  map.set(key, [value]);
}

function getJsonByteLength(value: JsonValue | Record<string, JsonValue>): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function isLlmVisibleContextEntry(
  entry: Pick<ContextEntryRecord, "admission" | "presentTo">,
): boolean {
  return entry.admission !== "state_only" && entry.presentTo !== "ui";
}

function createEmptyState(): SessionLineageState {
  return {
    nodes: new Map(),
    childrenByParent: new Map(),
    summariesByNode: new Map(),
    outcomesByNode: new Map(),
    outcomesById: new Map(),
    adoptedOutcomesByNode: new Map(),
    selectionsByChannel: new Map(),
    contextEntries: new Map(),
    contextEntriesByNode: new Map(),
    capabilityStates: [],
  };
}

export function deriveSessionLineageState(
  events: readonly BrewvaEventRecord[],
): SessionLineageState {
  const state = createEmptyState();
  for (const event of events) {
    const node = readSessionLineageNodeCreatedEventPayload(event);
    if (node) {
      const record: SessionLineageNodeRecord = {
        ...node,
        eventId: event.id,
        timestamp: event.timestamp,
      };
      state.nodes.set(record.lineageNodeId, record);
      if (record.parentLineageNodeId) {
        appendMapList(state.childrenByParent, record.parentLineageNodeId, record.lineageNodeId);
      }
      continue;
    }

    const summary = readSessionLineageSummaryRecordedEventPayload(event);
    if (summary) {
      appendMapList(state.summariesByNode, summary.lineageNodeId, {
        ...summary,
        eventId: event.id,
        timestamp: event.timestamp,
      });
      continue;
    }

    const outcome = readSessionLineageOutcomeRecordedEventPayload(event);
    if (outcome) {
      const record: SessionLineageOutcomeRecord = {
        ...outcome,
        eventId: event.id,
        timestamp: event.timestamp,
      };
      appendMapList(state.outcomesByNode, outcome.lineageNodeId, record);
      state.outcomesById.set(outcome.outcomeId, record);
      continue;
    }

    const adoption = readSessionLineageOutcomeAdoptedEventPayload(event);
    if (adoption) {
      appendMapList(state.adoptedOutcomesByNode, adoption.toLineageNodeId, {
        ...adoption,
        eventId: event.id,
        timestamp: event.timestamp,
      });
      continue;
    }

    const selection = readSessionLineageSelectionRecordedEventPayload(event);
    if (selection) {
      state.selectionsByChannel.set(selection.channelId, {
        ...selection,
        eventId: event.id,
        timestamp: event.timestamp,
      });
      continue;
    }

    const contextEntry = readContextEntryRecordedEventPayload(event);
    if (contextEntry) {
      const record: ContextEntryRecord = {
        ...contextEntry,
        eventId: event.id,
        timestamp: event.timestamp,
      };
      state.contextEntries.set(contextEntry.entryId, record);
      appendMapList(state.contextEntriesByNode, contextEntry.lineageNodeId, record);
      continue;
    }

    const capabilityState = readCapabilityStateRecordedEventPayload(event);
    if (capabilityState) {
      state.capabilityStates.push({
        ...capabilityState,
        eventId: event.id,
        timestamp: event.timestamp,
      });
    }
  }
  return state;
}

export function findSessionLineageRoot(
  state: SessionLineageState,
): SessionLineageNodeRecord | undefined {
  return [...state.nodes.values()].find(
    (node) => node.parentLineageNodeId === null && node.forkPoint.kind === "session_root",
  );
}

export class SessionLineageService {
  private readonly eventStore: BrewvaEventStore;
  private readonly recordEvent: RuntimeRecordEvent;
  private readonly isCapabilityStateOwnerDeclared: (ownerCapability: string) => boolean;
  private readonly maxInlineCapabilityStateBytes: number;
  private readonly runtimeCapabilityStateOwners = new Set<string>();

  constructor(options: SessionLineageServiceOptions) {
    this.eventStore = options.eventStore;
    this.recordEvent = options.recordEvent;
    this.isCapabilityStateOwnerDeclared = options.isCapabilityStateOwnerDeclared;
    this.maxInlineCapabilityStateBytes =
      options.maxInlineCapabilityStateBytes ?? CAPABILITY_STATE_INLINE_DATA_MAX_BYTES;
  }

  registerRuntimeCapabilityStateOwners(ownerCapabilities: Iterable<string>): void {
    for (const ownerCapability of ownerCapabilities) {
      const normalized = ownerCapability.trim();
      if (normalized) {
        this.runtimeCapabilityStateOwners.add(normalized);
      }
    }
  }

  createLineageNode(sessionId: string, input: CreateSessionLineageNodeInput): BrewvaEventRecord {
    const state = this.getState(sessionId);
    const parentLineageNodeId = input.parentLineageNodeId ?? null;
    if (state.nodes.has(input.lineageNodeId)) {
      throw new Error(`session_lineage_node_exists:${input.lineageNodeId}`);
    }
    if (parentLineageNodeId === null && input.forkPoint.kind !== "session_root") {
      throw new Error("session_lineage_root_requires_session_root_fork_point");
    }
    if (parentLineageNodeId !== null && !state.nodes.has(parentLineageNodeId)) {
      throw new Error(`session_lineage_parent_missing:${parentLineageNodeId}`);
    }
    if (input.forkPoint.kind === "session_root" && findSessionLineageRoot(state)) {
      throw new Error(`session_lineage_root_exists:${sessionId}`);
    }
    if (input.forkPoint.kind === "context_entry") {
      const forkEntry = state.contextEntries.get(input.forkPoint.entryId);
      if (!forkEntry) {
        throw new Error(`session_lineage_fork_entry_missing:${input.forkPoint.entryId}`);
      }
      if (forkEntry.lineageNodeId !== input.forkPoint.lineageNodeId) {
        throw new Error(`session_lineage_fork_entry_lineage_mismatch:${input.forkPoint.entryId}`);
      }
    }
    return requireRecordedEvent(
      this.recordEvent({
        sessionId,
        type: SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
        payload: {
          schema: SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
          lineageNodeId: input.lineageNodeId,
          parentLineageNodeId,
          kind: input.kind,
          forkPoint: input.forkPoint,
          ...(input.title ? { title: input.title } : {}),
          ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        },
      }),
      SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
    );
  }

  recordLineageSummary(
    sessionId: string,
    input: RecordSessionLineageSummaryInput,
  ): BrewvaEventRecord {
    this.requireNode(sessionId, input.lineageNodeId);
    const state = this.getState(sessionId);
    if (input.attachToEntryId && !state.contextEntries.has(input.attachToEntryId)) {
      throw new Error(`session_lineage_summary_attach_entry_missing:${input.attachToEntryId}`);
    }
    return requireRecordedEvent(
      this.recordEvent({
        sessionId,
        type: SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
        payload: {
          schema: SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
          summaryId: input.summaryId,
          lineageNodeId: input.lineageNodeId,
          attachToEntryId: input.attachToEntryId ?? null,
          summary: input.summary,
          admission: input.admission,
          ...(input.detailsArtifactRef ? { detailsArtifactRef: input.detailsArtifactRef } : {}),
        },
      }),
      SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
    );
  }

  recordLineageOutcome(
    sessionId: string,
    input: RecordSessionLineageOutcomeInput,
  ): BrewvaEventRecord {
    this.requireNode(sessionId, input.lineageNodeId);
    const state = this.getState(sessionId);
    if (state.outcomesById.has(input.outcomeId)) {
      throw new Error(`session_lineage_outcome_exists:${input.outcomeId}`);
    }
    if ((input.admission as ContextAdmission | undefined) === "context_required") {
      throw new Error(`session_lineage_outcome_requires_adoption:${input.outcomeId}`);
    }
    return requireRecordedEvent(
      this.recordEvent({
        sessionId,
        type: SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
        payload: {
          schema: SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
          outcomeId: input.outcomeId,
          lineageNodeId: input.lineageNodeId,
          summary: input.summary,
          admission: input.admission ?? "state_only",
          ...(input.outcomeRef ? { outcomeRef: input.outcomeRef } : {}),
          ...(input.detailsArtifactRef ? { detailsArtifactRef: input.detailsArtifactRef } : {}),
        },
      }),
      SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
    );
  }

  recordLineageSelection(
    sessionId: string,
    input: RecordSessionLineageSelectionInput,
  ): BrewvaEventRecord {
    this.requireNode(sessionId, input.lineageNodeId);
    if (input.previousLineageNodeId) {
      this.requireNode(sessionId, input.previousLineageNodeId);
    }
    return requireRecordedEvent(
      this.recordEvent({
        sessionId,
        type: SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE,
        payload: {
          schema: SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE,
          selectionId: input.selectionId,
          channelId: input.channelId,
          lineageNodeId: input.lineageNodeId,
          ...(input.previousLineageNodeId
            ? { previousLineageNodeId: input.previousLineageNodeId }
            : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      }),
      SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE,
    );
  }

  adoptLineageOutcome(
    sessionId: string,
    input: AdoptSessionLineageOutcomeInput,
  ): BrewvaEventRecord {
    this.requireNode(sessionId, input.fromLineageNodeId);
    this.requireNode(sessionId, input.toLineageNodeId);
    const state = this.getState(sessionId);
    const outcome = state.outcomesById.get(input.outcomeId);
    if (!outcome) {
      throw new Error(`session_lineage_outcome_missing:${input.outcomeId}`);
    }
    if (outcome.lineageNodeId !== input.fromLineageNodeId) {
      throw new Error(`session_lineage_outcome_lineage_mismatch:${input.outcomeId}`);
    }
    if (
      [...state.adoptedOutcomesByNode.values()]
        .flat()
        .some((adoption) => adoption.adoptionId === input.adoptionId)
    ) {
      throw new Error(`session_lineage_outcome_adoption_exists:${input.adoptionId}`);
    }
    return requireRecordedEvent(
      this.recordEvent({
        sessionId,
        type: SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
        payload: {
          schema: SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
          adoptionId: input.adoptionId,
          outcomeId: input.outcomeId,
          fromLineageNodeId: input.fromLineageNodeId,
          toLineageNodeId: input.toLineageNodeId,
          admission: input.admission,
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.adoptedEntryId ? { adoptedEntryId: input.adoptedEntryId } : {}),
        },
      }),
      SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
    );
  }

  recordContextEntry(sessionId: string, input: RecordContextEntryInput): BrewvaEventRecord {
    this.requireNode(sessionId, input.lineageNodeId);
    const state = this.getState(sessionId);
    if (state.contextEntries.has(input.entryId)) {
      throw new Error(`session_context_entry_exists:${input.entryId}`);
    }
    if (input.parentEntryId && !state.contextEntries.has(input.parentEntryId)) {
      throw new Error(`session_context_entry_parent_missing:${input.parentEntryId}`);
    }
    // Phase 2 validates source events by scanning the tape; Phase 3 should reuse
    // the memoized projection cache so hot context-entry writes are O(1).
    const sourceEvent = this.eventStore
      .list(sessionId)
      .find((event) => event.id === input.sourceEventId);
    if (!sourceEvent) {
      throw new Error(`session_context_entry_source_missing:${input.sourceEventId}`);
    }
    if (sourceEvent.type !== input.sourceEventType) {
      throw new Error(`session_context_entry_source_type_mismatch:${input.sourceEventId}`);
    }
    return requireRecordedEvent(
      this.recordEvent({
        sessionId,
        type: CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
        payload: {
          schema: CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
          ...input,
        },
      }),
      CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
    );
  }

  recordCapabilityState(sessionId: string, input: RecordCapabilityStateInput): BrewvaEventRecord {
    const ownerCapability = input.ownerCapability.trim();
    if (!ownerCapability) {
      throw new Error("capability_state_owner_undeclared:");
    }
    if (
      !this.runtimeCapabilityStateOwners.has(ownerCapability) &&
      !this.isCapabilityStateOwnerDeclared(ownerCapability)
    ) {
      throw new Error(`capability_state_owner_undeclared:${ownerCapability}`);
    }
    const inlineBytes = getJsonByteLength(input.data);
    if (inlineBytes > this.maxInlineCapabilityStateBytes) {
      throw new Error(
        `capability_state_inline_payload_too_large:${input.stateId}:${inlineBytes}:${this.maxInlineCapabilityStateBytes}`,
      );
    }
    if (input.lineageNodeId) {
      this.requireNode(sessionId, input.lineageNodeId);
    }
    return requireRecordedEvent(
      this.recordEvent({
        sessionId,
        type: CAPABILITY_STATE_RECORDED_EVENT_TYPE,
        payload: {
          schema: CAPABILITY_STATE_RECORDED_EVENT_TYPE,
          ...input,
          ownerCapability,
        },
      }),
      CAPABILITY_STATE_RECORDED_EVENT_TYPE,
    );
  }

  getLineageTree(sessionId: string): SessionLineageTree {
    const state = this.requireRootedState(sessionId);
    const root = findSessionLineageRoot(state);
    if (!root) {
      throw new Error(`session_lineage_root_missing:${sessionId}`);
    }
    const nodes = [...state.nodes.values()].map((node) => this.toNodeView(state, node));
    const edges: SessionLineageEdge[] = [];
    for (const [parentLineageNodeId, children] of state.childrenByParent.entries()) {
      for (const childLineageNodeId of children) {
        edges.push({ parentLineageNodeId, childLineageNodeId });
      }
    }
    return {
      sessionId,
      rootNodeId: root.lineageNodeId,
      nodes,
      edges,
      selectedByChannel: Object.fromEntries(
        [...state.selectionsByChannel.entries()].map(([channelId, selection]) => [
          channelId,
          selection.lineageNodeId,
        ]),
      ),
    };
  }

  getLineageNode(sessionId: string, lineageNodeId: string): SessionLineageNodeView | undefined {
    const state = this.requireRootedState(sessionId);
    const node = state.nodes.get(lineageNodeId);
    return node ? this.toNodeView(state, node) : undefined;
  }

  listLineageChildren(sessionId: string, lineageNodeId: string): SessionLineageNodeView[] {
    const state = this.requireRootedState(sessionId);
    return (state.childrenByParent.get(lineageNodeId) ?? [])
      .map((childId) => state.nodes.get(childId))
      .filter((node): node is SessionLineageNodeRecord => node !== undefined)
      .map((node) => this.toNodeView(state, node));
  }

  getContextEntryPath(
    sessionId: string,
    input: GetContextEntryPathInput = {},
  ): ContextEntryRecord[] {
    const state = this.requireRootedState(sessionId);
    const target = this.resolveContextEntryTarget(state, input);
    if (!target) return [];

    const path: ContextEntryRecord[] = [];
    const seen = new Set<string>();
    let current: ContextEntryRecord | undefined = target;
    while (current) {
      if (seen.has(current.entryId)) {
        throw new Error(`session_context_entry_cycle:${current.entryId}`);
      }
      seen.add(current.entryId);
      path.push(current);
      if (!current.parentEntryId) break;
      const parentEntryId = current.parentEntryId;
      current = state.contextEntries.get(parentEntryId);
      if (!current) {
        throw new Error(`session_context_entry_parent_missing:${parentEntryId}`);
      }
    }
    return path
      .toReversed()
      .filter((entry) => input.includeStateOnly === true || isLlmVisibleContextEntry(entry))
      .map((entry) => clonePayload(entry));
  }

  // Phase 2 derives lineage state per call from the tape. This is intentionally
  // simple while sessions are O(thousands) of events; Phase 3 should add a
  // memoized projection cache keyed by the latest event id.
  private getState(sessionId: string): SessionLineageState {
    return deriveSessionLineageState(this.eventStore.list(sessionId));
  }

  private requireRootedState(sessionId: string): SessionLineageState {
    const state = this.getState(sessionId);
    if (!findSessionLineageRoot(state)) {
      throw new Error(`session_lineage_root_missing:${sessionId}`);
    }
    return state;
  }

  private requireNode(sessionId: string, lineageNodeId: string): SessionLineageNodeRecord {
    const state = this.requireRootedState(sessionId);
    const node = state.nodes.get(lineageNodeId);
    if (!node) {
      throw new Error(`session_lineage_node_missing:${lineageNodeId}`);
    }
    return node;
  }

  private toNodeView(
    state: SessionLineageState,
    node: SessionLineageNodeRecord,
  ): SessionLineageNodeView {
    return clonePayload({
      ...node,
      summaries: state.summariesByNode.get(node.lineageNodeId) ?? [],
      outcomes: state.outcomesByNode.get(node.lineageNodeId) ?? [],
      adoptedOutcomes: state.adoptedOutcomesByNode.get(node.lineageNodeId) ?? [],
    });
  }

  private resolveContextEntryTarget(
    state: SessionLineageState,
    input: GetContextEntryPathInput,
  ): ContextEntryRecord | undefined {
    if (input.entryId) {
      return state.contextEntries.get(input.entryId);
    }
    if (input.lineageNodeId) {
      const entries = state.contextEntriesByNode.get(input.lineageNodeId) ?? [];
      return entries[entries.length - 1];
    }
    const entries = [...state.contextEntries.values()];
    return entries[entries.length - 1];
  }
}
