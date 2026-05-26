import { randomUUID } from "node:crypto";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { isRecord, readFiniteNumberValue } from "@brewva/brewva-std/unknown";
import {
  DEFAULT_CONTEXT_STATE,
  buildManagedSessionContext,
  type BrewvaBranchSummaryEntry,
  type BrewvaCompactionEntry,
  type BrewvaModelChangeEntry,
  type BrewvaModelPresetSelectEntry,
  type BrewvaModelRoleAlias,
  type BrewvaModelRoleMap,
  type BrewvaSessionContext,
  type BrewvaSessionEntry,
  type BrewvaSessionMessageEntry,
  type BrewvaThinkingLevelChangeEntry,
  type ContextState,
} from "@brewva/brewva-substrate/session";
import {
  CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
  readContextEntryRecordedEventPayload,
} from "@brewva/brewva-vocabulary/context";
import {
  type ContextEntryRecord,
  isLlmVisibleContextEntry,
} from "@brewva/brewva-vocabulary/context";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  MODEL_PRESET_SELECT_EVENT_TYPE,
  MODEL_SELECT_EVENT_TYPE,
  readReasoningRevertEventPayload,
  REASONING_REVERT_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import type {
  SessionCompactionCacheImpact,
  SessionCompactionCacheImpactSnapshot,
  SessionCompactionGenerationMetadata,
} from "@brewva/brewva-vocabulary/session";
import {
  MESSAGE_END_EVENT_TYPE,
  readSessionRewindCompletedEventPayload,
  SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V1,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/session";
import {
  SESSION_REWIND_DIVERGENCE_SCHEMA,
  type SessionLifecycleSnapshot,
} from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import {
  SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
  THINKING_LEVEL_SELECTED_EVENT_TYPE,
  buildTranscriptMessagePayload,
  readTranscriptMessageFromPayload,
  type StoredSessionMessage,
} from "../../turn-adapter/runtime-session-transcript.js";
import {
  commitRuntimeSessionCompaction,
  createRuntimeLineageNode,
  getRuntimeContextPromptHistoryViewBaseline,
  getRuntimeContextStatus,
  getRuntimeContextUsage,
  getRuntimeContextEvidenceLatest,
  getRuntimeLifecycleSnapshot,
  getRuntimeSessionLineageContextEntryPath,
  getRuntimeSessionLineageNode,
  getRuntimeSessionLineageTree,
  listRuntimeEvents,
  listRuntimeSessionLineageChildren,
  listRuntimeWorkbenchEntries,
  queryRuntimeSessionWire,
  recordHostedRuntimeEvent,
  recordRuntimeLineageContextEntry,
  recordRuntimeLineageSummary,
  subscribeRuntimeEvents,
  subscribeRuntimeSessionWire,
  type HostedRuntimeAdapterPort,
} from "../runtime-ports.js";
import {
  isContextSourceEvent,
  readBranchSummaryPayload,
  readCanonicalCompactionPayload,
  resolveContextEntryInputForSourceEvent,
} from "./context-entry-linker.js";
import { shouldExcludeSessionEntryForWorkbench } from "./workbench-visibility.js";

type CustomMessageContentPart = { type: string };
type DeferredInitialSessionEntries = {
  modelPresetSelection?: {
    presetName: string;
    previousPresetName?: string;
    source?: string;
    roles?: BrewvaModelRoleMap;
    synthetic?: boolean;
  };
  modelChange?: {
    provider: string;
    modelId: string;
  };
  thinkingLevel?: string;
};

const SESSION_COMPACT_EVENT_TYPE = "session_compact";
const HOSTED_MAIN_LINEAGE_NODE_ID = "lineage:main";

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function readCacheImpactSnapshot(value: unknown): SessionCompactionCacheImpactSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    cacheReadTokens: readNonNegativeInteger(value.cacheReadTokens),
    cacheWriteTokens: readNonNegativeInteger(value.cacheWriteTokens),
    bucketKey: readNullableString(value.bucketKey),
    stablePrefixHash: readNullableString(value.stablePrefixHash),
    dynamicTailHash: readNullableString(value.dynamicTailHash),
    visibleHistoryReductionHash: readNullableString(value.visibleHistoryReductionHash),
    workbenchContextHash: readNullableString(value.workbenchContextHash),
  };
}

function readCacheImpact(value: unknown): SessionCompactionCacheImpact {
  const record = isRecord(value) ? value : {};
  return {
    before: readCacheImpactSnapshot(record.before),
    after: readCacheImpactSnapshot(record.after),
    explicitEpochChanges: readNonNegativeInteger(record.explicitEpochChanges) || 1,
    prefixBytesChanged:
      typeof record.prefixBytesChanged === "number" && Number.isFinite(record.prefixBytesChanged)
        ? Math.max(0, Math.trunc(record.prefixBytesChanged))
        : null,
    degradedReason: readNullableString(record.degradedReason),
  };
}

function readCompactionGenerationMetadata(
  value: unknown,
): SessionCompactionGenerationMetadata | undefined {
  if (
    !isRecord(value) ||
    typeof value.strategy !== "string" ||
    value.strategy.trim().length === 0
  ) {
    return undefined;
  }
  return value as unknown as SessionCompactionGenerationMetadata;
}

function readCompactionInputProvenance(value: unknown): unknown {
  return isRecord(value) &&
    value.schema === SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V1 &&
    value.hiddenRecallSearch === false
    ? value
    : undefined;
}

const MODEL_ROLE_ALIASES = new Set<BrewvaModelRoleAlias>([
  "default",
  "smol",
  "slow",
  "plan",
  "commit",
  "task",
]);

function readOptionalRoleMap(value: unknown): BrewvaModelRoleMap | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record: BrewvaModelRoleMap = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (
      MODEL_ROLE_ALIASES.has(key as BrewvaModelRoleAlias) &&
      typeof rawValue === "string" &&
      rawValue.trim().length > 0
    ) {
      record[key as BrewvaModelRoleAlias] = rawValue.trim();
    }
  }
  return Object.keys(record).length > 0 ? record : {};
}

function mapContextBudgetPressure(status: {
  compactionAdvised: boolean;
  forcedCompaction: boolean;
}): ContextState["budgetPressure"] {
  if (status.forcedCompaction) return "high";
  if (status.compactionAdvised) return "medium";
  return "none";
}

function toEntryTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function sortEvents(events: BrewvaEventRecord[]): BrewvaEventRecord[] {
  return events
    .map((event, index) => ({ event, index }))
    .toSorted((left, right) => {
      if (left.event.timestamp !== right.event.timestamp) {
        return left.event.timestamp - right.event.timestamp;
      }
      return left.index - right.index;
    })
    .map(({ event }) => event);
}

function selectFirstKeptEntryId(branchEntries: readonly BrewvaSessionEntry[]): string | null {
  const keepable = branchEntries.filter(
    (entry) =>
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary",
  );
  if (keepable.length === 0) {
    return null;
  }
  return keepable[Math.max(0, keepable.length - 2)]?.id ?? null;
}

export class HostedRuntimeTapeSessionStore {
  readonly #entries: BrewvaSessionEntry[] = [];
  readonly #byId = new Map<string, BrewvaSessionEntry>();
  readonly #eventsById = new Map<string, BrewvaEventRecord>();
  readonly #seenEventIds = new Set<string>();
  readonly #rewindSummaryModeByRevertEventId = new Map<string, "carry" | "none">();
  #leafId: string | null = null;
  #lineageNodeId: string = HOSTED_MAIN_LINEAGE_NODE_ID;
  #unsubscribeEvents: (() => void) | null = null;
  #deferInitialPersistence = false;
  #initialPersistenceEnsured = false;
  #deferredInitialEntries: DeferredInitialSessionEntries = {};
  readonly sessionId: string;

  constructor(
    private readonly runtime: HostedRuntimeAdapterPort,
    sessionId: string = randomUUID(),
    options: { deferInitialPersistence?: boolean } = {},
  ) {
    this.sessionId = sessionId;
    const existingEvents = listRuntimeEvents(this.runtime, this.sessionId);
    this.#deferInitialPersistence =
      options.deferInitialPersistence === true && existingEvents.length === 0;
    if (!this.#deferInitialPersistence) {
      this.#ensureLineageRoot();
      this.#initialPersistenceEnsured = true;
    }
    this.#hydrateFromRuntime();
    this.#unsubscribeEvents = subscribeRuntimeEvents(this.runtime, (event) => {
      if (event.sessionId !== this.sessionId) {
        return;
      }
      this.#ingestRuntimeEvent(event);
    });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getLeafId(): string | null {
    return this.#leafId;
  }

  getLineageNodeId(): string {
    return this.#lineageNodeId;
  }

  hasSessionEntryType(type: string): boolean {
    return this.#entries.some((entry) => entry.type === type);
  }

  deferInitialSessionEntries(input: DeferredInitialSessionEntries): void {
    if (!this.#deferInitialPersistence || this.#initialPersistenceEnsured) {
      if (input.modelPresetSelection) {
        this.appendModelPresetSelection(input.modelPresetSelection);
      }
      if (input.modelChange) {
        this.appendModelChange(input.modelChange.provider, input.modelChange.modelId);
      }
      if (input.thinkingLevel) {
        this.appendThinkingLevelChange(input.thinkingLevel);
      }
      return;
    }
    this.#deferredInitialEntries = {
      modelPresetSelection: input.modelPresetSelection,
      modelChange: input.modelChange,
      thinkingLevel: input.thinkingLevel,
    };
  }

  ensureInitialPersistence(): void {
    if (this.#initialPersistenceEnsured) {
      return;
    }
    this.#initialPersistenceEnsured = true;
    this.#deferInitialPersistence = false;
    const deferred = this.#deferredInitialEntries;
    this.#deferredInitialEntries = {};
    this.#ensureLineageRoot();
    if (deferred.modelPresetSelection) {
      this.appendModelPresetSelection(deferred.modelPresetSelection);
    }
    if (deferred.modelChange) {
      this.appendModelChange(deferred.modelChange.provider, deferred.modelChange.modelId);
    }
    if (deferred.thinkingLevel) {
      this.appendThinkingLevelChange(deferred.thinkingLevel);
    }
  }

  readContextState(): ContextState {
    const usage = getRuntimeContextUsage(this.runtime, this.sessionId);
    const contextStatus = getRuntimeContextStatus(this.runtime, this.sessionId, usage);
    const promptStability = getRuntimeContextEvidenceLatest(
      this.runtime,
      this.sessionId,
      "prompt_stability",
    )?.payload;
    const transientReduction = getRuntimeContextEvidenceLatest(
      this.runtime,
      this.sessionId,
      "transient_reduction",
    )?.payload;
    const promptStabilityFingerprint =
      typeof promptStability?.stablePrefixHash === "string"
        ? promptStability.stablePrefixHash
        : undefined;

    return {
      ...DEFAULT_CONTEXT_STATE,
      budgetPressure: mapContextBudgetPressure(contextStatus),
      promptStabilityFingerprint,
      transientReductionActive: transientReduction?.status === "completed",
      historyBaselineAvailable:
        getRuntimeContextPromptHistoryViewBaseline(this.runtime, this.sessionId) !== undefined,
    };
  }

  readLifecycle(): SessionLifecycleSnapshot {
    return getRuntimeLifecycleSnapshot(this.runtime, this.sessionId);
  }

  resetLeaf(): void {
    this.#leafId = null;
    this.#lineageNodeId = HOSTED_MAIN_LINEAGE_NODE_ID;
  }

  branch(entryId: string): void {
    if (!this.#byId.has(entryId)) {
      throw new Error(`Entry ${entryId} not found`);
    }
    const targetEntryId = this.#nearestContextEntryId(entryId);
    if (!targetEntryId) {
      this.#leafId = null;
      return;
    }
    if (targetEntryId === this.#leafId) {
      return;
    }
    const targetContextEntry = this.#resolveContextEntry(targetEntryId);
    if (!targetContextEntry) {
      throw new Error(`Context entry ${targetEntryId} not found`);
    }
    const targetLineageNodeId = targetContextEntry.lineageNodeId;
    const existingBranch = listRuntimeSessionLineageChildren(
      this.runtime,
      this.sessionId,
      targetLineageNodeId,
    ).find(
      (node) =>
        node.kind === "branch" &&
        node.forkPoint.kind === "context_entry" &&
        node.forkPoint.lineageNodeId === targetLineageNodeId &&
        node.forkPoint.entryId === targetEntryId,
    );
    const branchNodeId = existingBranch?.lineageNodeId ?? `lineage:${randomUUID()}`;
    if (!existingBranch) {
      createRuntimeLineageNode(this.runtime, this.sessionId, {
        lineageNodeId: branchNodeId,
        parentLineageNodeId: targetLineageNodeId,
        kind: "branch",
        forkPoint: {
          kind: "context_entry",
          lineageNodeId: targetLineageNodeId,
          entryId: targetEntryId,
        },
        createdBy: "hosted-session-store",
      });
    }
    this.#lineageNodeId = branchNodeId;
    this.#leafId = targetEntryId;
  }

  checkoutLineageNode(lineageNodeId: string, leafEntryId?: string | null): void {
    const node = getRuntimeSessionLineageNode(this.runtime, this.sessionId, lineageNodeId);
    if (!node) {
      throw new Error(`session_lineage_node_missing:${lineageNodeId}`);
    }
    const nextLeafId = this.#resolveCheckoutLeafEntryId(lineageNodeId, leafEntryId);
    this.#lineageNodeId = lineageNodeId;
    this.#leafId = nextLeafId;
  }

  resolveLineageLeafEntryId(lineageNodeId: string): string | null {
    return this.#resolveCheckoutLeafEntryId(lineageNodeId, undefined);
  }

  dispose(): void {
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = null;
  }

  subscribeSessionWire(listener: (frame: SessionWireFrame) => void): () => void {
    return subscribeRuntimeSessionWire(this.runtime, this.sessionId, listener);
  }

  querySessionWire(): SessionWireFrame[] {
    return queryRuntimeSessionWire(this.runtime, this.sessionId);
  }

  getBranch(fromId?: string | null): BrewvaSessionEntry[] {
    const startId = fromId === undefined ? this.#leafId : fromId;
    if (!startId) {
      return [];
    }
    return getRuntimeSessionLineageContextEntryPath(this.runtime, this.sessionId, {
      entryId: startId,
      includeStateOnly: true,
    })
      .map((entry) => this.#byId.get(entry.entryId))
      .filter((entry): entry is BrewvaSessionEntry => entry !== undefined);
  }

  #getLlmBranch(fromId?: string | null): BrewvaSessionEntry[] {
    const startId = fromId === undefined ? this.#leafId : fromId;
    if (!startId) {
      return [];
    }

    const contextEntries = getRuntimeSessionLineageContextEntryPath(this.runtime, this.sessionId, {
      entryId: startId,
    }).filter(isLlmVisibleContextEntry);
    const entries: BrewvaSessionEntry[] = [];
    let parentEntryId: string | null = null;
    const workbenchEntries = listRuntimeWorkbenchEntries(this.runtime, this.sessionId);
    for (const [index, contextEntry] of contextEntries.entries()) {
      const entry = this.#contextEntryRecordToSessionEntry(contextEntry, parentEntryId);
      if (!entry) {
        continue;
      }
      const sourceEvent =
        this.#eventsById.get(contextEntry.sourceEventId) ??
        listRuntimeEvents(this.runtime, this.sessionId).find(
          (candidate) => candidate.id === contextEntry.sourceEventId,
        );
      if (
        shouldExcludeSessionEntryForWorkbench({
          entry,
          sourceEvent,
          index,
          workbenchEntries,
        })
      ) {
        continue;
      }
      entries.push(entry);
      parentEntryId = entry.id;
    }
    return entries;
  }

  buildSessionContext(): BrewvaSessionContext {
    const contextEntries = this.#getLlmBranch(this.#leafId);
    const contextIndex = new Map(contextEntries.map((entry) => [entry.id, entry] as const));
    const contextLeafId = contextEntries[contextEntries.length - 1]?.id ?? null;
    const context = buildManagedSessionContext(contextEntries, contextLeafId, contextIndex);
    return {
      ...context,
      ...this.#readControlState(),
    };
  }

  previewCompaction(
    summary: string,
    tokensBefore: number,
    compactId: string = randomUUID(),
    sourceLeafEntryId: string | null = this.#leafId,
  ): {
    compactId: string;
    sourceLeafEntryId: string | null;
    firstKeptEntryId: string;
    context: BrewvaSessionContext;
    tokensBefore: number;
    summary: string;
  } {
    const branchEntries = this.#getLlmBranch(sourceLeafEntryId);
    const firstKeptEntryId = selectFirstKeptEntryId(branchEntries);
    if (!firstKeptEntryId) {
      throw new Error("Hosted compaction requires at least one message entry to keep.");
    }

    const previewParentId = branchEntries[branchEntries.length - 1]?.id ?? sourceLeafEntryId;
    const previewEntry: BrewvaCompactionEntry = {
      type: "compaction",
      id: compactId,
      parentId: previewParentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      fromHook: true,
    };
    const previewEntries = [...branchEntries, previewEntry];
    const previewIndex = new Map(branchEntries.map((entry) => [entry.id, entry] as const));
    previewIndex.set(previewEntry.id, previewEntry);

    return {
      compactId,
      sourceLeafEntryId,
      firstKeptEntryId,
      context: buildManagedSessionContext(previewEntries, previewEntry.id, previewIndex),
      tokensBefore,
      summary,
    };
  }

  appendMessage(message: StoredSessionMessage): string {
    this.ensureInitialPersistence();
    const event = recordHostedRuntimeEvent(this.runtime, {
      sessionId: this.sessionId,
      type: MESSAGE_END_EVENT_TYPE,
      payload: buildTranscriptMessagePayload(message),
    });
    if (!event) {
      throw new Error("failed to record canonical session message");
    }
    this.#ingestRuntimeEvent(event);
    return event.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    if (this.#deferInitialPersistence && !this.#initialPersistenceEnsured) {
      this.#deferredInitialEntries.thinkingLevel = thinkingLevel;
      return `deferred:thinking:${this.sessionId}`;
    }
    const event = recordHostedRuntimeEvent(this.runtime, {
      sessionId: this.sessionId,
      type: THINKING_LEVEL_SELECTED_EVENT_TYPE,
      payload: {
        thinkingLevel,
      },
    });
    if (!event) {
      throw new Error("failed to record thinking level selection");
    }
    this.#ingestRuntimeEvent(event);
    return event.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    if (this.#deferInitialPersistence && !this.#initialPersistenceEnsured) {
      this.#deferredInitialEntries.modelChange = { provider, modelId };
      return `deferred:model:${this.sessionId}`;
    }
    const event = recordHostedRuntimeEvent(this.runtime, {
      sessionId: this.sessionId,
      type: MODEL_SELECT_EVENT_TYPE,
      payload: {
        provider,
        model: modelId,
        source: "session_store",
      },
    });
    if (!event) {
      throw new Error("failed to record model selection");
    }
    this.#ingestRuntimeEvent(event);
    return event.id;
  }

  appendModelPresetSelection(input: {
    presetName: string;
    previousPresetName?: string;
    source?: string;
    roles?: BrewvaModelRoleMap;
    synthetic?: boolean;
  }): string {
    if (this.#deferInitialPersistence && !this.#initialPersistenceEnsured) {
      this.#deferredInitialEntries.modelPresetSelection = {
        presetName: input.presetName,
        previousPresetName: input.previousPresetName,
        source: input.source,
        roles: input.roles ? { ...input.roles } : undefined,
        synthetic: input.synthetic,
      };
      return `deferred:preset:${this.sessionId}`;
    }
    const event = recordHostedRuntimeEvent(this.runtime, {
      sessionId: this.sessionId,
      type: MODEL_PRESET_SELECT_EVENT_TYPE,
      payload: {
        presetName: input.presetName,
        previousPresetName: input.previousPresetName,
        source: input.source ?? "session_store",
        roles: input.roles ? { ...input.roles } : undefined,
        synthetic: input.synthetic,
      },
    });
    if (!event) {
      throw new Error("failed to record model preset selection");
    }
    this.#ingestRuntimeEvent(event);
    return event.id;
  }

  appendCustomMessageEntry(
    customType: string,
    content: string | CustomMessageContentPart[],
    display: boolean,
    details?: unknown,
  ): string {
    return this.appendMessage({
      role: "custom",
      customType,
      content,
      display,
      details,
      timestamp: Date.now(),
    });
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    replaceCurrent?: boolean,
  ): string {
    const detailRecord =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined;
    const revertId = readOptionalString(detailRecord?.revertId);
    if (revertId) {
      if (replaceCurrent) {
        this.#hydrateFromRuntime();
      }
      return revertId;
    }

    const event = recordHostedRuntimeEvent(this.runtime, {
      sessionId: this.sessionId,
      type: SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
      payload: {
        targetLeafEntryId: branchFromId,
        summary,
        details: detailRecord,
        replaceCurrent: replaceCurrent === true,
      },
    });
    if (!event) {
      throw new Error("failed to record branch summary");
    }
    this.#ingestRuntimeEvent(event);
    recordRuntimeLineageSummary(this.runtime, this.sessionId, {
      summaryId: event.id,
      lineageNodeId: this.#lineageNodeId,
      attachToEntryId: branchFromId,
      summary,
      admission: "context_eligible",
    });
    return event.id;
  }

  async appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): Promise<string> {
    const detailRecord =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined;
    const summaryGeneration = readCompactionGenerationMetadata(detailRecord?.summaryGeneration);
    const inputProvenance = readCompactionInputProvenance(detailRecord?.inputProvenance);
    const event = commitRuntimeSessionCompaction(this.runtime, this.sessionId, {
      compactId: readOptionalString(detailRecord?.compactId) ?? randomUUID(),
      sanitizedSummary: summary,
      summaryDigest: readOptionalString(detailRecord?.summaryDigest) ?? sha256Hex(summary),
      sourceTurn: readFiniteNumberValue(detailRecord?.sourceTurn) ?? 0,
      leafEntryId: this.#leafId,
      firstKeptEntryId,
      referenceContextDigest:
        detailRecord?.referenceContextDigest === null
          ? null
          : (readOptionalString(detailRecord?.referenceContextDigest) ?? null),
      fromTokens: tokensBefore,
      toTokens: readFiniteNumberValue(detailRecord?.toTokens) ?? null,
      origin:
        (readOptionalString(detailRecord?.origin) as
          | "auto_compaction"
          | "extension_api"
          | "hosted_recovery"
          | undefined) ?? (fromHook ? "extension_api" : "hosted_recovery"),
      ...(summaryGeneration ? { summaryGeneration } : {}),
      ...(inputProvenance ? { inputProvenance } : {}),
      cacheImpact: readCacheImpact(detailRecord?.cacheImpact),
    });
    if (!event) {
      throw new Error("failed to record compaction");
    }
    this.#ingestRuntimeEvent(event);
    return event.id;
  }

  appendBranchSummaryEntry(
    parentId: string | null,
    fromId: string,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    if (parentId !== null && !this.#byId.has(parentId)) {
      throw new Error(`Entry ${parentId} not found`);
    }
    const detailRecord =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined;
    const contextParentId = parentId === null ? null : this.#nearestContextEntryId(parentId);
    this.#leafId = contextParentId;
    const event = recordHostedRuntimeEvent(this.runtime, {
      sessionId: this.sessionId,
      type: SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
      payload: {
        targetLeafEntryId: contextParentId,
        fromId,
        summary,
        details: {
          ...detailRecord,
          fromHook: fromHook === true,
        },
      },
    });
    if (!event) {
      throw new Error("failed to record branch summary");
    }
    this.#ingestRuntimeEvent(event);
    recordRuntimeLineageSummary(this.runtime, this.sessionId, {
      summaryId: event.id,
      lineageNodeId: this.#lineageNodeId,
      attachToEntryId: contextParentId,
      summary,
      admission: "context_eligible",
    });
    return event.id;
  }

  #hydrateFromRuntime(): void {
    this.#entries.length = 0;
    this.#byId.clear();
    this.#eventsById.clear();
    this.#seenEventIds.clear();
    this.#rewindSummaryModeByRevertEventId.clear();
    this.#leafId = null;

    const events = sortEvents(listRuntimeEvents(this.runtime, this.sessionId));
    for (const event of events) {
      const rewind =
        event.type === SESSION_REWIND_COMPLETED_EVENT_TYPE
          ? readSessionRewindCompletedEventPayload(event)
          : null;
      if (rewind?.ok === true && rewind.reasoningRevertEventId) {
        this.#rewindSummaryModeByRevertEventId.set(rewind.reasoningRevertEventId, rewind.summary);
      }
    }
    for (const event of events) {
      this.#ingestRuntimeEvent(event, { fromHydration: true });
    }
  }

  #ingestRuntimeEvent(event: BrewvaEventRecord, options: { fromHydration?: boolean } = {}): void {
    if (this.#seenEventIds.has(event.id)) {
      return;
    }
    this.#seenEventIds.add(event.id);
    this.#eventsById.set(event.id, event);
    if (event.type === SESSION_REWIND_COMPLETED_EVENT_TYPE) {
      const rewind = readSessionRewindCompletedEventPayload(event);
      if (rewind?.ok === true && rewind.reasoningRevertEventId) {
        this.#rewindSummaryModeByRevertEventId.set(rewind.reasoningRevertEventId, rewind.summary);
        if (rewind.divergenceNote && options.fromHydration !== true) {
          this.#maybeUpgradeRewindToRecoveryLineage(event);
          this.#recordContextEntryForSourceEvent(event);
          if (rewind.summary === "none") {
            this.#hydrateFromRuntime();
          }
          return;
        }
        if (rewind.summary === "none" && options.fromHydration !== true) {
          this.#hydrateFromRuntime();
          return;
        }
      }
    }
    if (event.type === REASONING_REVERT_EVENT_TYPE) {
      const revert = readReasoningRevertEventPayload(event);
      if (revert && this.#rewindSummaryModeByRevertEventId.get(event.id) === "none") {
        this.#leafId = revert.targetLeafEntryId ?? null;
        return;
      }
    }
    if (isContextSourceEvent(event)) {
      if (options.fromHydration !== true) {
        this.#recordContextEntryForSourceEvent(event);
      }
      return;
    }
    if (event.type === CONTEXT_ENTRY_RECORDED_EVENT_TYPE) {
      const entry = this.#contextEntryToSessionEntry(event);
      if (!entry) {
        return;
      }
      this.#entries.push(entry);
      this.#byId.set(entry.id, entry);
      this.#leafId = entry.id;
      this.#lineageNodeId =
        readContextEntryRecordedEventPayload(event)?.lineageNodeId ?? this.#lineageNodeId;
      return;
    }

    const entry = this.#canonicalEventToEntry(event);
    if (!entry) {
      return;
    }
    this.#entries.push(entry);
    this.#byId.set(entry.id, entry);
  }

  #ensureLineageRoot(): void {
    const events = listRuntimeEvents(this.runtime, this.sessionId);
    try {
      const tree = getRuntimeSessionLineageTree(this.runtime, this.sessionId);
      if (tree.rootNodeId) {
        this.#lineageNodeId = tree.rootNodeId;
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("session_lineage_root_missing")) {
        throw error;
      }
      if (events.length > 0) {
        throw error;
      }
    }

    createRuntimeLineageNode(this.runtime, this.sessionId, {
      lineageNodeId: HOSTED_MAIN_LINEAGE_NODE_ID,
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
      createdBy: "hosted-session-store",
    });
    this.#lineageNodeId = HOSTED_MAIN_LINEAGE_NODE_ID;
  }

  #recordContextEntryForSourceEvent(sourceEvent: BrewvaEventRecord): void {
    if (this.#hasContextEntryForSourceEvent(sourceEvent.id)) {
      return;
    }
    const input = resolveContextEntryInputForSourceEvent({
      sourceEvent,
      currentLeafId: this.#leafId,
    });
    if (!input) {
      return;
    }
    const event = recordRuntimeLineageContextEntry(this.runtime, this.sessionId, {
      entryId: sourceEvent.id,
      lineageNodeId: this.#lineageNodeId,
      parentEntryId: input.parentEntryId,
      sourceEventId: sourceEvent.id,
      sourceEventType: sourceEvent.type,
      entryKind: input.entryKind,
      admission: input.admission,
      presentTo: input.presentTo,
    });
    this.#ingestRuntimeEvent(event);
  }

  #maybeUpgradeRewindToRecoveryLineage(sourceEvent: BrewvaEventRecord): void {
    const rewind = readSessionRewindCompletedEventPayload(sourceEvent);
    if (!rewind?.ok || !rewind.divergenceNote) {
      return;
    }
    if (rewind.trigger !== "rewind") {
      return;
    }
    const forkEntryId = rewind.divergenceNote.parentLeafEntryId ?? rewind.returnLeafEntryId;
    if (!forkEntryId) {
      return;
    }
    const forkEntry = this.#resolveContextEntry(forkEntryId);
    if (!forkEntry) {
      return;
    }
    const lineageNodeId = `lineage:recovery:${sourceEvent.id}`;
    try {
      createRuntimeLineageNode(this.runtime, this.sessionId, {
        lineageNodeId,
        parentLineageNodeId: forkEntry.lineageNodeId,
        kind: "recovery",
        forkPoint: {
          kind: "context_entry",
          lineageNodeId: forkEntry.lineageNodeId,
          entryId: forkEntry.entryId,
        },
        createdBy: "session-rewind",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(`session_lineage_node_exists:${lineageNodeId}`)) {
        throw error;
      }
    }
    this.#lineageNodeId = lineageNodeId;
    this.#leafId = forkEntry.entryId;
  }

  #hasContextEntryForSourceEvent(sourceEventId: string): boolean {
    return listRuntimeEvents(this.runtime, this.sessionId).some((event) => {
      if (event.type !== CONTEXT_ENTRY_RECORDED_EVENT_TYPE) {
        return false;
      }
      return readContextEntryRecordedEventPayload(event)?.sourceEventId === sourceEventId;
    });
  }

  #contextEntryToSessionEntry(event: BrewvaEventRecord): BrewvaSessionEntry | undefined {
    const contextEntry = readContextEntryRecordedEventPayload(event);
    if (!contextEntry) {
      return undefined;
    }
    return this.#contextEntryRecordToSessionEntry({
      ...contextEntry,
      eventId: event.id,
      timestamp: event.timestamp,
    });
  }

  #contextEntryRecordToSessionEntry(
    contextEntry: ContextEntryRecord,
    parentEntryId: string | null = contextEntry.parentEntryId,
  ): BrewvaSessionEntry | undefined {
    const sourceEvent =
      this.#eventsById.get(contextEntry.sourceEventId) ??
      listRuntimeEvents(this.runtime, this.sessionId).find(
        (candidate) => candidate.id === contextEntry.sourceEventId,
      );
    if (!sourceEvent) {
      return undefined;
    }
    return this.#canonicalEventToEntry(sourceEvent, {
      entryId: contextEntry.entryId,
      parentEntryId,
    });
  }

  #readControlState(): Omit<BrewvaSessionContext, "messages"> {
    const control: Omit<BrewvaSessionContext, "messages"> = {
      thinkingLevel: "off",
      model: null,
      activeModelPresetName: "Default",
      activeModelPreset: {
        name: "Default",
        roles: {},
        synthetic: true,
      },
    };
    for (const entry of this.#entries) {
      if (entry.type === "thinking_level_change") {
        control.thinkingLevel = entry.thinkingLevel as BrewvaSessionContext["thinkingLevel"];
        continue;
      }
      if (entry.type === "model_change") {
        control.model = { provider: entry.provider, modelId: entry.modelId };
        continue;
      }
      if (entry.type === "model_preset_select") {
        control.activeModelPresetName = entry.presetName;
        control.activeModelPreset = {
          name: entry.presetName,
          roles: entry.roles ? { ...entry.roles } : {},
          synthetic: entry.synthetic,
        };
        continue;
      }
      if (
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        typeof (entry.message as { provider?: unknown }).provider === "string" &&
        typeof (entry.message as { model?: unknown }).model === "string"
      ) {
        const message = entry.message as unknown as { provider: string; model: string };
        control.model = { provider: message.provider, modelId: message.model };
      }
    }
    return control;
  }

  #nearestContextEntryId(entryId: string): string | null {
    let current = this.#byId.get(entryId);
    while (current) {
      if (
        current.type === "message" ||
        current.type === "custom_message" ||
        current.type === "branch_summary" ||
        current.type === "compaction"
      ) {
        return current.id;
      }
      current = current.parentId ? this.#byId.get(current.parentId) : undefined;
    }
    return null;
  }

  #resolveContextEntry(entryId: string): ContextEntryRecord | undefined {
    return getRuntimeSessionLineageContextEntryPath(this.runtime, this.sessionId, {
      entryId,
      includeStateOnly: true,
    }).find((entry) => entry.entryId === entryId);
  }

  #resolveCheckoutLeafEntryId(
    lineageNodeId: string,
    leafEntryId: string | null | undefined,
  ): string | null {
    const node = getRuntimeSessionLineageNode(this.runtime, this.sessionId, lineageNodeId);
    if (!node) {
      throw new Error(`session_lineage_node_missing:${lineageNodeId}`);
    }

    if (leafEntryId === null) {
      return null;
    }
    if (leafEntryId !== undefined) {
      const path = getRuntimeSessionLineageContextEntryPath(this.runtime, this.sessionId, {
        entryId: leafEntryId,
        includeStateOnly: true,
      });
      const leafRecord = path.at(-1);
      if (!leafRecord || leafRecord.entryId !== leafEntryId) {
        throw new Error(`session_context_entry_missing:${leafEntryId}`);
      }
      const isForkPointEntry =
        node.forkPoint.kind === "context_entry" && node.forkPoint.entryId === leafEntryId;
      if (!isForkPointEntry && leafRecord.lineageNodeId !== lineageNodeId) {
        throw new Error(`session_context_entry_lineage_mismatch:${leafEntryId}:${lineageNodeId}`);
      }
      return leafEntryId;
    }

    const nodePath = getRuntimeSessionLineageContextEntryPath(this.runtime, this.sessionId, {
      lineageNodeId,
      includeStateOnly: true,
    });
    const nodeLeaf = nodePath.at(-1)?.entryId;
    if (nodeLeaf) {
      return nodeLeaf;
    }
    if (node.forkPoint.kind === "context_entry") {
      return node.forkPoint.entryId;
    }
    return null;
  }

  #canonicalEventToEntry(
    event: BrewvaEventRecord,
    context?: { entryId: string; parentEntryId: string | null },
  ): BrewvaSessionEntry | undefined {
    const payload = isRecord(event.payload) ? event.payload : {};
    const timestamp = toEntryTimestamp(event.timestamp);
    const entryId = context?.entryId ?? event.id;
    const parentId = context?.parentEntryId ?? null;

    if (event.type === MESSAGE_END_EVENT_TYPE) {
      const message = readTranscriptMessageFromPayload(payload);
      if (!message) {
        return undefined;
      }
      return {
        type: "message",
        id: entryId,
        parentId,
        timestamp,
        message,
      } satisfies BrewvaSessionMessageEntry;
    }

    if (event.type === MODEL_SELECT_EVENT_TYPE) {
      const provider = readOptionalString(payload.provider);
      const modelId = readOptionalString(payload.model);
      if (!provider || !modelId) {
        return undefined;
      }
      return {
        type: "model_change",
        id: event.id,
        parentId: this.#leafId,
        timestamp,
        provider,
        modelId,
      } satisfies BrewvaModelChangeEntry;
    }

    if (event.type === MODEL_PRESET_SELECT_EVENT_TYPE) {
      const presetName = readOptionalString(payload.presetName);
      if (!presetName) {
        return undefined;
      }
      return {
        type: MODEL_PRESET_SELECT_EVENT_TYPE,
        id: event.id,
        parentId: this.#leafId,
        timestamp,
        presetName,
        previousPresetName: readOptionalString(payload.previousPresetName),
        source: readOptionalString(payload.source),
        roles: readOptionalRoleMap(payload.roles),
        synthetic: payload.synthetic === true ? true : undefined,
      } satisfies BrewvaModelPresetSelectEntry;
    }

    if (event.type === THINKING_LEVEL_SELECTED_EVENT_TYPE) {
      const thinkingLevel = readOptionalString(payload.thinkingLevel);
      if (!thinkingLevel) {
        return undefined;
      }
      return {
        type: "thinking_level_change",
        id: event.id,
        parentId: this.#leafId,
        timestamp,
        thinkingLevel,
      } satisfies BrewvaThinkingLevelChangeEntry;
    }

    if (event.type === REASONING_REVERT_EVENT_TYPE) {
      const revert = readReasoningRevertEventPayload(event);
      if (!revert) {
        return undefined;
      }
      return {
        type: "branch_summary",
        id: entryId,
        parentId: context?.parentEntryId ?? revert.targetLeafEntryId ?? null,
        timestamp,
        fromId: revert.targetLeafEntryId ?? "root",
        summary: revert.continuityPacket.text,
        details: {
          schema: revert.continuityPacket.schema,
          revertId: revert.revertId,
          toCheckpointId: revert.toCheckpointId,
          trigger: revert.trigger,
          linkedRollbackReceiptIds: revert.linkedRollbackReceiptIds,
        },
        fromHook: true,
      } satisfies BrewvaBranchSummaryEntry;
    }

    if (event.type === SESSION_REWIND_COMPLETED_EVENT_TYPE) {
      const rewind = readSessionRewindCompletedEventPayload(event);
      if (!rewind || !rewind.ok || !rewind.divergenceNote) {
        return undefined;
      }
      const divergenceNote = rewind.divergenceNote;
      return {
        type: "branch_summary",
        id: entryId,
        parentId,
        timestamp,
        fromId: parentId ?? "root",
        summary: divergenceNote.text,
        details: {
          schema: SESSION_REWIND_DIVERGENCE_SCHEMA,
          kind: divergenceNote.kind,
          patchSetCount: divergenceNote.patchSetCount,
        },
        fromHook: true,
      } satisfies BrewvaBranchSummaryEntry;
    }

    if (event.type === SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE) {
      const branchSummary = readBranchSummaryPayload(payload);
      if (!branchSummary) {
        return undefined;
      }
      return {
        type: "branch_summary",
        id: entryId,
        parentId: context?.parentEntryId ?? branchSummary.targetLeafEntryId,
        timestamp,
        fromId: branchSummary.fromId ?? branchSummary.targetLeafEntryId ?? "root",
        summary: branchSummary.summary,
        details:
          isRecord(branchSummary.details) && "importedDetails" in branchSummary.details
            ? branchSummary.details.importedDetails
            : branchSummary.details,
        fromHook: true,
      } satisfies BrewvaBranchSummaryEntry;
    }

    if (event.type === SESSION_COMPACT_EVENT_TYPE) {
      const compaction = readCanonicalCompactionPayload(payload);
      if (!compaction) {
        return undefined;
      }
      const branchEntries = this.#getLlmBranch(compaction.leafEntryId ?? this.#leafId);
      const firstKeptEntryId = selectFirstKeptEntryId(branchEntries);
      if (!firstKeptEntryId) {
        return undefined;
      }
      const payloadFirstKeptEntryId = readOptionalString(payload.firstKeptEntryId);
      return {
        type: "compaction",
        id: entryId,
        parentId: context?.parentEntryId ?? compaction.leafEntryId ?? this.#leafId,
        timestamp,
        summary: compaction.sanitizedSummary,
        firstKeptEntryId:
          payloadFirstKeptEntryId &&
          branchEntries.some((entry) => entry.id === payloadFirstKeptEntryId)
            ? payloadFirstKeptEntryId
            : firstKeptEntryId,
        tokensBefore: compaction.fromTokens ?? 0,
        details: payload.importedDetails ?? {
          compactId: compaction.compactId,
          sourceTurn: compaction.sourceTurn,
          referenceContextDigest: compaction.referenceContextDigest,
          toTokens: compaction.toTokens,
          origin: compaction.origin,
          summaryDigest: compaction.summaryDigest,
          summaryGeneration: compaction.summaryGeneration,
          integrityViolations: compaction.integrityViolations,
        },
        fromHook: true,
      } satisfies BrewvaCompactionEntry;
    }
    return undefined;
  }
}
