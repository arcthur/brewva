import { randomUUID } from "node:crypto";
import {
  MESSAGE_END_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
  type BrewvaEventRecord,
  type BrewvaRuntime,
  type SessionWireFrame,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  DEFAULT_CONTEXT_STATE,
  buildManagedSessionContext,
  type BrewvaBranchSummaryEntry,
  type BrewvaCompactionEntry,
  type ContextState,
  type BrewvaModelChangeEntry,
  type BrewvaSessionContext,
  type BrewvaSessionEntry,
  type BrewvaSessionMessageEntry,
  type BrewvaThinkingLevelChangeEntry,
} from "@brewva/brewva-substrate";
import {
  SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
  THINKING_LEVEL_SELECTED_EVENT_TYPE,
  buildTranscriptMessagePayload,
  readTranscriptMessageFromPayload,
  type StoredSessionMessage,
} from "../session/runtime-session-transcript.js";
import {
  hasLegacyHostedProjectionEvents,
  migrateLegacyHostedProjectionEvents,
} from "./legacy-hosted-session-projection.js";

type CustomMessageContentPart = { type: string };

const MODEL_SELECT_EVENT_TYPE = "model_select";
const SESSION_COMPACT_EVENT_TYPE = "session_compact";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseScopeId(scopeKey: string | undefined): string | undefined {
  if (!scopeKey) {
    return undefined;
  }
  const separatorIndex = scopeKey.indexOf("::");
  if (separatorIndex < 0) {
    return undefined;
  }
  const scopeId = scopeKey.slice(separatorIndex + 2).trim();
  return scopeId.length > 0 && scopeId !== "root" ? scopeId : undefined;
}

function mapContextPressureLevel(level: string | undefined): ContextState["budgetPressure"] {
  switch (level) {
    case "low":
    case "medium":
    case "high":
      return level;
    case "critical":
      return "high";
    default:
      return "none";
  }
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

function readCanonicalCompactionPayload(payload: unknown): {
  compactId: string;
  sanitizedSummary: string;
  sourceTurn: number;
  leafEntryId: string | null;
  referenceContextDigest: string | null;
  fromTokens: number | null;
  toTokens: number | null;
  origin: string;
  summaryDigest?: string;
  integrityViolations?: unknown;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  const compactId = readOptionalString(payload.compactId);
  const sanitizedSummary =
    typeof payload.sanitizedSummary === "string" ? payload.sanitizedSummary : "";
  const sourceTurn = readOptionalNumber(payload.sourceTurn);
  const origin = readOptionalString(payload.origin);
  if (!compactId || sourceTurn === undefined || !origin) {
    return null;
  }
  return {
    compactId,
    sanitizedSummary,
    sourceTurn,
    leafEntryId:
      payload.leafEntryId === null ? null : (readOptionalString(payload.leafEntryId) ?? null),
    referenceContextDigest:
      payload.referenceContextDigest === null
        ? null
        : (readOptionalString(payload.referenceContextDigest) ?? null),
    fromTokens:
      typeof payload.fromTokens === "number" && Number.isFinite(payload.fromTokens)
        ? payload.fromTokens
        : null,
    toTokens:
      typeof payload.toTokens === "number" && Number.isFinite(payload.toTokens)
        ? payload.toTokens
        : null,
    origin,
    summaryDigest: readOptionalString(payload.summaryDigest),
    integrityViolations: payload.integrityViolations,
  };
}

function readReasoningRevertPayload(payload: unknown): {
  revertId: string;
  toCheckpointId: string;
  trigger: string;
  continuityText: string;
  linkedRollbackReceiptIds: string[];
  targetLeafEntryId: string | null;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  const revertId = readOptionalString(payload.revertId);
  const toCheckpointId = readOptionalString(payload.toCheckpointId);
  const trigger = readOptionalString(payload.trigger);
  const continuityPacket = isRecord(payload.continuityPacket) ? payload.continuityPacket : null;
  const continuityText =
    continuityPacket && typeof continuityPacket.text === "string"
      ? continuityPacket.text.trim()
      : "";
  const linkedRollbackReceiptIds = Array.isArray(payload.linkedRollbackReceiptIds)
    ? payload.linkedRollbackReceiptIds.flatMap((value) =>
        typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [],
      )
    : [];
  if (!revertId || !toCheckpointId || !trigger || continuityText.length === 0) {
    return null;
  }
  return {
    revertId,
    toCheckpointId,
    trigger,
    continuityText,
    linkedRollbackReceiptIds,
    targetLeafEntryId:
      payload.targetLeafEntryId === null
        ? null
        : (readOptionalString(payload.targetLeafEntryId) ?? null),
  };
}

function readBranchSummaryPayload(payload: unknown): {
  summary: string;
  targetLeafEntryId: string | null;
  fromId: string | null;
  details?: unknown;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  if (summary.trim().length === 0) {
    return null;
  }
  return {
    summary,
    targetLeafEntryId:
      payload.targetLeafEntryId === null
        ? null
        : (readOptionalString(payload.targetLeafEntryId) ?? null),
    fromId: payload.fromId === null ? null : (readOptionalString(payload.fromId) ?? null),
    details: payload.details,
  };
}

function hasCanonicalTranscriptEvents(events: readonly BrewvaEventRecord[]): boolean {
  return events.some(
    (event) =>
      (event.type === MESSAGE_END_EVENT_TYPE &&
        readTranscriptMessageFromPayload(event.payload) !== null) ||
      (event.type === MODEL_SELECT_EVENT_TYPE &&
        isRecord(event.payload) &&
        readOptionalString(event.payload.provider) &&
        readOptionalString(event.payload.model)) ||
      (event.type === THINKING_LEVEL_SELECTED_EVENT_TYPE &&
        isRecord(event.payload) &&
        readOptionalString(event.payload.thinkingLevel)) ||
      (event.type === REASONING_REVERT_EVENT_TYPE &&
        readReasoningRevertPayload(event.payload) !== null) ||
      (event.type === SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE &&
        readBranchSummaryPayload(event.payload) !== null) ||
      (event.type === SESSION_COMPACT_EVENT_TYPE &&
        readCanonicalCompactionPayload(event.payload) !== null),
  );
}

export class HostedRuntimeTapeSessionStore {
  readonly #entries: BrewvaSessionEntry[] = [];
  readonly #byId = new Map<string, BrewvaSessionEntry>();
  readonly #seenEventIds = new Set<string>();
  #leafId: string | null = null;
  #unsubscribeEvents: (() => void) | null = null;

  constructor(
    private readonly runtime: BrewvaRuntime,
    private readonly cwd: string,
    private readonly sessionId: string = randomUUID(),
  ) {
    this.#hydrateFromRuntime();
    this.#unsubscribeEvents = this.runtime.inspect.events.subscribe((event) => {
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

  readContextState(): ContextState {
    const usage = this.runtime.inspect.context.getUsage(this.sessionId);
    const pressure = this.runtime.inspect.context.getPressureStatus(this.sessionId, usage);
    const promptStability = this.runtime.inspect.context.getPromptStability(this.sessionId);
    const injectionScopeId = parseScopeId(promptStability?.scopeKey);

    return {
      ...DEFAULT_CONTEXT_STATE,
      budgetPressure: mapContextPressureLevel(pressure.level),
      promptStabilityFingerprint: promptStability?.stablePrefixHash,
      transientReductionActive:
        this.runtime.inspect.context.getTransientReduction(this.sessionId)?.status === "completed",
      historyBaselineAvailable:
        this.runtime.inspect.context.getHistoryViewBaseline(this.sessionId) !== undefined,
      reservedPrimaryTokens: this.runtime.inspect.context.getReservedPrimaryTokens(
        this.sessionId,
        injectionScopeId,
      ),
      reservedSupplementalTokens: this.runtime.inspect.context.getReservedSupplementalTokens(
        this.sessionId,
        injectionScopeId,
      ),
      lastInjectionScopeId: injectionScopeId,
    };
  }

  resetLeaf(): void {
    this.#leafId = null;
  }

  branch(entryId: string): void {
    if (!this.#byId.has(entryId)) {
      throw new Error(`Entry ${entryId} not found`);
    }
    this.#leafId = entryId;
  }

  dispose(): void {
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = null;
  }

  subscribeSessionWire(listener: (frame: SessionWireFrame) => void): () => void {
    return this.runtime.inspect.sessionWire.subscribe(this.sessionId, listener);
  }

  querySessionWire(): SessionWireFrame[] {
    return this.runtime.inspect.sessionWire.query(this.sessionId);
  }

  getBranch(fromId?: string | null): BrewvaSessionEntry[] {
    const path: BrewvaSessionEntry[] = [];
    const startId = fromId === undefined ? this.#leafId : fromId;
    let current = startId ? this.#byId.get(startId) : undefined;
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.#byId.get(current.parentId) : undefined;
    }
    return path;
  }

  buildSessionContext(): BrewvaSessionContext {
    return buildManagedSessionContext(this.#entries, this.#leafId, this.#byId);
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
    const branchEntries = this.getBranch(sourceLeafEntryId);
    const firstKeptEntryId = selectFirstKeptEntryId(branchEntries);
    if (!firstKeptEntryId) {
      throw new Error("Hosted compaction requires at least one message entry to keep.");
    }

    const previewEntry: BrewvaCompactionEntry = {
      type: "compaction",
      id: compactId,
      parentId: sourceLeafEntryId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      fromHook: true,
    };
    const previewEntries = [...this.#entries, previewEntry];
    const previewIndex = new Map(this.#byId);
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
    const event = recordRuntimeEvent(this.runtime, {
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
    const event = recordRuntimeEvent(this.runtime, {
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
    const event = recordRuntimeEvent(this.runtime, {
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

    const event = recordRuntimeEvent(this.runtime, {
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
    return event.id;
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    const event = recordRuntimeEvent(this.runtime, {
      sessionId: this.sessionId,
      type: SESSION_COMPACT_EVENT_TYPE,
      payload: {
        compactId: randomUUID(),
        sanitizedSummary: summary,
        sourceTurn: 0,
        leafEntryId: this.#leafId,
        firstKeptEntryId,
        referenceContextDigest: null,
        fromTokens: tokensBefore,
        toTokens: null,
        origin: fromHook ? "extension_api" : "hosted_recovery",
        importedDetails: details,
      },
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
    this.#leafId = parentId;
    const event = recordRuntimeEvent(this.runtime, {
      sessionId: this.sessionId,
      type: SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
      payload: {
        targetLeafEntryId: parentId,
        fromId,
        summary,
        details: {
          importedDetails: details,
          fromHook: fromHook === true,
        },
      },
    });
    if (!event) {
      throw new Error("failed to record branch summary");
    }
    this.#ingestRuntimeEvent(event);
    return event.id;
  }

  #hydrateFromRuntime(): void {
    this.#entries.length = 0;
    this.#byId.clear();
    this.#seenEventIds.clear();
    this.#leafId = null;

    const initialEvents = sortEvents(this.runtime.inspect.events.list(this.sessionId));
    if (
      hasLegacyHostedProjectionEvents(initialEvents) &&
      !hasCanonicalTranscriptEvents(initialEvents)
    ) {
      migrateLegacyHostedProjectionEvents(this.runtime, this.sessionId, initialEvents);
    }

    const events = sortEvents(this.runtime.inspect.events.list(this.sessionId));
    for (const event of events) {
      this.#ingestRuntimeEvent(event);
    }
  }

  #ingestRuntimeEvent(event: BrewvaEventRecord): void {
    if (this.#seenEventIds.has(event.id)) {
      return;
    }
    this.#seenEventIds.add(event.id);
    const entry = this.#canonicalEventToEntry(event);
    if (!entry) {
      return;
    }
    this.#entries.push(entry);
    this.#byId.set(entry.id, entry);
    this.#leafId = entry.id;
  }

  #canonicalEventToEntry(event: BrewvaEventRecord): BrewvaSessionEntry | undefined {
    const payload = isRecord(event.payload) ? event.payload : {};
    const timestamp = toEntryTimestamp(event.timestamp);

    if (event.type === MESSAGE_END_EVENT_TYPE) {
      const message = readTranscriptMessageFromPayload(payload);
      if (!message) {
        return undefined;
      }
      return {
        type: "message",
        id: event.id,
        parentId: this.#leafId,
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
      const revert = readReasoningRevertPayload(payload);
      if (!revert) {
        return undefined;
      }
      return {
        type: "branch_summary",
        id: event.id,
        parentId: revert.targetLeafEntryId,
        timestamp,
        fromId: revert.targetLeafEntryId ?? "root",
        summary: revert.continuityText,
        details: {
          schema: "brewva.reasoning.continuity.v1",
          revertId: revert.revertId,
          toCheckpointId: revert.toCheckpointId,
          trigger: revert.trigger,
          linkedRollbackReceiptIds: revert.linkedRollbackReceiptIds,
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
        id: event.id,
        parentId: branchSummary.targetLeafEntryId,
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
      const branchEntries = this.getBranch(compaction.leafEntryId ?? this.#leafId);
      const firstKeptEntryId = selectFirstKeptEntryId(branchEntries);
      if (!firstKeptEntryId) {
        return undefined;
      }
      return {
        type: "compaction",
        id: event.id,
        parentId: compaction.leafEntryId ?? this.#leafId,
        timestamp,
        summary: compaction.sanitizedSummary,
        firstKeptEntryId: readOptionalString(payload.firstKeptEntryId) ?? firstKeptEntryId,
        tokensBefore: compaction.fromTokens ?? 0,
        details: payload.importedDetails ?? {
          compactId: compaction.compactId,
          sourceTurn: compaction.sourceTurn,
          referenceContextDigest: compaction.referenceContextDigest,
          toTokens: compaction.toTokens,
          origin: compaction.origin,
          summaryDigest: compaction.summaryDigest,
          integrityViolations: compaction.integrityViolations,
        },
        fromHook: true,
      } satisfies BrewvaCompactionEntry;
    }

    return undefined;
  }
}
