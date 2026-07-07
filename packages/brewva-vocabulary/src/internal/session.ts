import { CONTEXT_ENTRY_RECORDED_EVENT_TYPE, type ContextEntryRecord } from "./context.js";
import { type BrewvaEventRecord } from "./events.js";
import { isProtocolRecord, optionalStringField, readStringArray, stringField } from "./shared.js";
import type { ProtocolRecord } from "./types/foundation.js";
import { type SessionWireFrame, type ToolOutputView, type TurnEnvelope } from "./wire.js";

export type { ProtocolRecord } from "./types/foundation.js";

export { SESSION_REWIND_DIVERGENCE_SCHEMA } from "./types/session-rewind.js";

export type {
  RecordSessionRewindCheckpointInput,
  SessionPromptSnapshot,
  SessionRedoInput,
  SessionRedoResult,
  SessionRewindInput,
  SessionRewindMode,
  SessionRewindResult,
  SessionRewindState,
  SessionRewindSummary,
  SessionRewindTargetView,
} from "./types/session-rewind.js";

export interface BrewvaReplaySession {
  readonly sessionId: string;
  readonly title?: string;
  readonly eventCount: number;
  readonly lastEventAt: number;
  readonly frames?: readonly SessionWireFrame[];
  readonly events?: readonly BrewvaEventRecord[];
  readonly [key: string]: unknown;
}

export const DEFAULT_SESSION_TITLE = "Untitled session" as const;

export const MESSAGE_END_EVENT_TYPE = "message.end" as const;

export const RECOVERY_WAL_APPENDED_EVENT_TYPE = "recovery.wal.appended" as const;

export const RECOVERY_WAL_COMPACTED_EVENT_TYPE = "recovery.wal.compacted" as const;

export const RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE =
  "recovery.wal.recovery.completed" as const;

export const RECOVERY_WAL_STATUS_CHANGED_EVENT_TYPE = "recovery.wal.status.changed" as const;

export const SESSION_COMPACT_EVENT_TYPE = "session.compact" as const;

export const SESSION_COMPACT_FAILED_EVENT_TYPE = "session.compact.failed" as const;

export const SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE = "session.compact.request.failed" as const;

export const SESSION_COMPACT_REQUESTED_EVENT_TYPE = "session.compact.requested" as const;

export const SESSION_PRE_COMPACT_PRUNE_EVENT_TYPE = "session.pre_compact_prune" as const;

export const SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE = "session.lineage.node.created" as const;

export const SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE =
  "session.lineage.outcome.adopted" as const;

export const SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE =
  "session.lineage.outcome.recorded" as const;

export const SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE =
  "session.lineage.summary.recorded" as const;

export const SESSION_REWIND_COMPLETED_EVENT_TYPE = "session.rewind.completed" as const;

// Underscore on purpose: every producer (lifecycle builder, lineage
// self-heal, out-of-band shutdown receipts) has always written
// "session_shutdown", so the durable spelling wins and readers unify on
// this constant (contract-liveness audit, 2026-07-02).
export const SESSION_SHUTDOWN_EVENT_TYPE = "session_shutdown" as const;

// The spelling the title generator has always emitted (audit 2026-07-02).
export const SESSION_TITLE_GENERATED_EVENT_TYPE = "session.title.generated" as const;

// Continuation anchors land as tape.handoff (audit 2026-07-02).
export const TAPE_HANDOFF_EVENT_TYPE = "tape.handoff" as const;

// The runtime kernel commits canonical checkpoint.committed events (audit 2026-07-02).
export const CHECKPOINT_COMMITTED_EVENT_TYPE = "checkpoint.committed" as const;

export const TURN_INPUT_RECORDED_EVENT_TYPE = "turn.input.recorded" as const;

export const TURN_RENDER_COMMITTED_EVENT_TYPE = "turn.render.committed" as const;

export type ManagedToolMode = "hosted" | "direct";

export interface HistoryViewBaselineSnapshot {
  readonly eventId?: string;
  readonly timestamp?: number;
  readonly compactId?: string | null;
  readonly sanitizedSummary?: string | null;
  readonly origin?: string | null;
  readonly sourceTurn?: number | null;
  readonly leafEntryId?: string | null;
  readonly referenceContextDigest?: string | null;
  readonly fromTokens?: number | null;
  readonly toTokens?: number | null;
  readonly summaryDigest?: string | null;
  readonly rebuildSource?: string | null;
  readonly diagnostics: readonly unknown[];
}

export interface OutputSearchTelemetryState extends ProtocolRecord {
  readonly recentCalls: number;
  readonly singleQueryCalls: number;
  readonly batchedCalls: number;
  readonly throttledCalls: number;
  readonly blockedCalls: number;
  readonly lastThrottleLevel: string;
  readonly totalQueries: number;
  readonly totalResults: number;
  readonly averageResultsPerQuery: number | null;
  readonly cacheHitRate: number | null;
  readonly matchLayers: {
    readonly exact: number;
    readonly partial: number;
    readonly fuzzy: number;
    readonly none: number;
  };
  readonly lastTimestamp?: number | null;
}

export interface SessionCompactionCacheImpact extends ProtocolRecord {}

export interface SessionCompactionCacheImpactSnapshot extends ProtocolRecord {}

export interface SessionCompactionGenerationMetadata extends ProtocolRecord {}

export type SessionCompactionRecallSourceFamily = "tape_evidence" | "repository_precedent";

export type SessionCompactionRecallSessionScope =
  | "current_session"
  | "prior_session"
  | "cross_workspace";

export interface SessionCompactionRecallResultRef extends ProtocolRecord {
  readonly stableId: string;
  readonly sourceFamily: SessionCompactionRecallSourceFamily;
  readonly sessionScope: SessionCompactionRecallSessionScope;
  readonly rootRef: string;
}

export interface SessionCompactionResourceRef extends ProtocolRecord {
  readonly kind: "reference" | "script" | "invariant";
  readonly path: string;
}

// Work Card projection domain (TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
// TaskWorkCardContextPressure, TaskWorkCardProjection) lives in
// internal/work-card.ts: Task 6's evidence fields pushed this module past the
// 800-line internal budget, and split-over-bump is the sanctioned convention.
// The public path (@brewva/brewva-vocabulary/session) is unchanged.

export const ATTENTION_OPTION_PROJECTION_SCHEMA_V1 =
  "brewva.attention-option.projection.v1" as const;

export type AttentionOptionSourceFamily =
  | "skill_card"
  | "workbench"
  | "surfaced_recall"
  | "session_tape_evidence"
  | "repository_precedent"
  // A write/verify-phase trap-library lens that matched a file the session
  // touched (see @brewva/brewva-tools/trap-library) — an advisory review
  // stance surfaced as its own candidate card, honestly distinct from a
  // recall/skill/workbench/tape-evidence source (Task 9).
  | "trap_lens";

export type AttentionOptionAuthorityPosture = "none" | "read_context" | "write_workbench";

export interface AttentionOptionProjection extends ProtocolRecord {
  readonly schema: typeof ATTENTION_OPTION_PROJECTION_SCHEMA_V1;
  readonly optionId: string;
  readonly generationId: string;
  readonly sourceFamily: AttentionOptionSourceFamily;
  readonly rootRef: string;
  readonly title: string;
  readonly whyRelevant: string;
  readonly tokenEstimate: number | null;
  readonly resourceRefs: readonly string[];
  readonly outputArtifacts: readonly string[];
  readonly allowedActions: readonly AttentionOptionActionKind[];
  readonly authorityPosture: AttentionOptionAuthorityPosture;
}

export type AttentionOptionActionKind = "consume" | "pin" | "ignore" | "verify_plan";

export interface SessionCompactionAttentionRefs extends ProtocolRecord {
  readonly generationIds: readonly string[];
  readonly consumedRefs: readonly string[];
  readonly pinnedRefs: readonly string[];
  readonly ignoredRefs: readonly string[];
  readonly verifyPlanRefs: readonly string[];
}

export const SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V2 =
  "brewva.compaction.input-provenance.v2" as const;

export interface SessionCompactionInputProvenance extends ProtocolRecord {
  readonly schema: typeof SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V2;
  readonly hiddenRecallSearch: false;
  readonly activeWorkbenchEntryIds: readonly string[];
  readonly selectedSkillInvocationIds: readonly string[];
  readonly surfacedResourceRefs: readonly SessionCompactionResourceRef[];
  readonly capabilityReceiptRefs: readonly string[];
  readonly recallResultRefs: readonly SessionCompactionRecallResultRef[];
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly workbenchReferencedFiles: readonly string[];
  readonly recallFilesUsedInSummaryInput: readonly string[];
  readonly compactBaseline: unknown;
  readonly usedRecallSelection: {
    readonly maxResults: number;
    readonly selectedStableIds: readonly string[];
  };
  readonly attention?: SessionCompactionAttentionRefs;
}

export const SESSION_PRE_COMPACT_PRUNE_SCHEMA_V1 = "brewva.pre-compaction-prune.v1" as const;

export type SessionPruneOperationKind = "dedupe" | "inform_replace" | "image_strip";

/**
 * One deterministic pre-compaction transformation applied to the LLM
 * summarizer's input (never to the tape). `index` is the position in the
 * summarizer input array (messages carry no id); `toolCallId` is the stable
 * per-result reference where the tool-result message carried one.
 */
export interface SessionPruneOperation extends ProtocolRecord {
  readonly index: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly operation: SessionPruneOperationKind;
  readonly originalDigest: string;
  readonly replacementSummary: string;
}

/**
 * Receipt for the deterministic pre-compaction prune. It records what was
 * deduped/replaced/stripped from the summarizer input; the original content is
 * unchanged on the tape (the prune never mutates it). `compactId` is the shared
 * join key to the subsequent `session.compact` receipt.
 */
export interface SessionPreCompactPrunePayload extends ProtocolRecord {
  readonly schema: typeof SESSION_PRE_COMPACT_PRUNE_SCHEMA_V1;
  readonly sessionId: string;
  readonly compactId: string;
  readonly operations: readonly SessionPruneOperation[];
  readonly tokensSaved: number;
}

export function readSessionPreCompactPrunePayload(event: {
  readonly payload?: ProtocolRecord;
}): SessionPreCompactPrunePayload | null {
  const payload = event.payload;
  if (!payload || payload.schema !== SESSION_PRE_COMPACT_PRUNE_SCHEMA_V1) {
    return null;
  }
  return payload as SessionPreCompactPrunePayload;
}

export type TapeHandoffResult =
  | {
      readonly ok: true;
      readonly eventId?: string;
      readonly createdAt?: number;
      readonly tapeStatus?: TapeStatusState;
    }
  | {
      readonly ok: false;
      readonly reason?: string;
      readonly tapeStatus?: TapeStatusState;
    };

export type TapePressureLevel = string;

export interface TapeSearchMatch extends ProtocolRecord {
  readonly eventId: string;
  readonly type: string;
  readonly turn?: string | null;
  readonly timestamp: number;
  readonly excerpt: string;
}

export interface TapeSearchResult extends ProtocolRecord {
  readonly matches: readonly TapeSearchMatch[];
  readonly scannedEvents: number;
}

export type TapeSearchScope = string;

export interface TapeStatusState extends ProtocolRecord {
  readonly tapePressure: TapePressureLevel;
  readonly totalEntries: number;
  readonly entriesSinceAnchor: number;
  readonly entriesSinceCheckpoint: number;
  readonly thresholds: {
    readonly low: number;
    readonly medium: number;
    readonly high: number;
  };
  readonly lastAnchor?: {
    readonly id: string;
    readonly name?: string;
    readonly summary?: string;
    readonly nextSteps?: string;
  } | null;
  readonly lastCheckpointId?: string | null;
  readonly outputSearch?: OutputSearchTelemetryState | null;
}

export interface ContinuationAnchorRelevanceDecision {
  readonly include: boolean;
  readonly reason: "missing" | "checkpoint_only" | "available";
  readonly anchorId: string | null;
}

export interface ContinuationAnchorCandidate {
  readonly id: string;
  readonly name?: string | null;
  readonly summary?: string | null;
  readonly nextSteps?: string | null;
}

function hasContinuationAnchorText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function decideContinuationAnchorRelevance(
  anchor?: ContinuationAnchorCandidate | null,
): ContinuationAnchorRelevanceDecision {
  if (!anchor) {
    return { include: false, reason: "missing", anchorId: null };
  }
  if (
    !hasContinuationAnchorText(anchor.name) &&
    !hasContinuationAnchorText(anchor.summary) &&
    !hasContinuationAnchorText(anchor.nextSteps)
  ) {
    return { include: false, reason: "checkpoint_only", anchorId: anchor.id };
  }
  return { include: true, reason: "available", anchorId: anchor.id };
}

export interface SessionUncleanShutdownDiagnostic extends ProtocolRecord {
  readonly detectedAt: number;
  readonly reasons: readonly string[];
  readonly openToolCalls: readonly OpenToolCallRecord[];
  readonly openTurns?: readonly OpenTurnRecord[];
  readonly latestEventType?: string;
}

export interface SessionLifecycleSnapshot extends ProtocolRecord {
  readonly summary: {
    readonly kind: string;
    readonly reason?: string | null;
    readonly detail?: string | null;
    readonly [key: string]: unknown;
  };
  readonly execution: SessionLifecycleExecutionSnapshot;
  readonly recovery: {
    readonly pendingFamily?: string | null;
    readonly latestStatus?: string | null;
    readonly [key: string]: unknown;
  };
  readonly tooling: {
    readonly openToolCalls: readonly OpenToolCallRecord[];
    readonly [key: string]: unknown;
  };
  readonly openToolCalls?: readonly OpenToolCallRecord[];
  readonly openTurns?: readonly OpenTurnRecord[];
  readonly approvals?: readonly SessionLifecycleApprovalSnapshot[];
  readonly executions?: readonly SessionLifecycleExecutionSnapshot[];
}

export interface SessionLifecycleApprovalSnapshot extends ProtocolRecord {}

export interface SessionLifecycleExecutionSnapshot extends ProtocolRecord {
  readonly kind: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly requestId?: string;
  readonly reason?: string;
  readonly detail?: string;
}

export interface CreateBrewvaSessionOptions {
  readonly cwd?: string;
  readonly model?: string;
  readonly configPath?: string;
  readonly config?: ProtocolRecord;
  readonly agentId?: string;
  readonly managedToolMode?: ManagedToolMode;
  readonly managedToolNames?: readonly string[];
}

export interface OpenToolCallRecord extends ProtocolRecord {
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly turn?: number;
  readonly openedAt: number;
}

export interface OpenTurnRecord extends ProtocolRecord {
  readonly turn: number | string;
  readonly startedAt: number;
}

export type ForkPoint =
  | { kind: "session_root"; parentSessionId?: string | null }
  | { kind: "reasoning_checkpoint"; reasoningCheckpointId: string }
  | { kind: "turn"; turnId: string }
  | { kind: "context_entry"; lineageNodeId: string; entryId: string }
  | { kind: "tool_call"; toolCallId: string }
  | { kind: "patch_set"; patchSetId: string }
  | { kind: "worker_run"; workerRunId: string };

export interface SessionLineageNodeRecord {
  readonly lineageNodeId: string;
  readonly parentLineageNodeId: string | null;
  readonly kind: string;
  readonly title?: string | null;
  readonly createdBy?: string | null;
  readonly eventId: string;
  readonly timestamp: number;
  readonly summaries: readonly (ProtocolRecord & { readonly summaryId?: string })[];
  readonly outcomes: readonly (ProtocolRecord & { readonly outcomeId?: string })[];
  readonly adoptedOutcomes: readonly (ProtocolRecord & { readonly adoptionId?: string })[];
  readonly forkPoint: ForkPoint;
}

export interface SessionLineageOutcomeAdoptionRecord extends ProtocolRecord {
  readonly adoptionId: string;
  readonly outcomeId: string;
  readonly fromLineageNodeId: string;
  readonly toLineageNodeId: string;
  readonly admission: string;
  readonly summary?: string | null;
  readonly adoptedEntryId?: string | null;
  readonly eventId: string;
  readonly timestamp: number;
}

export interface SessionLineageOutcomeRecord extends ProtocolRecord {
  readonly outcomeId: string;
  readonly lineageNodeId: string;
  readonly admission: string;
  readonly summary: string;
  readonly outcomeRef?: string | null;
  readonly detailsArtifactRef?: string | null;
  readonly eventId: string;
  readonly timestamp: number;
}

export interface SessionLineageSummaryRecord extends ProtocolRecord {
  readonly summaryId: string;
  readonly lineageNodeId: string;
  readonly attachToEntryId: string;
  readonly admission: string;
  readonly summary: string;
  readonly detailsArtifactRef?: string | null;
  readonly eventId: string;
  readonly timestamp: number;
}

export interface SessionLineageTree {
  sessionId: string;
  rootNodeId: string | null;
  nodes: SessionLineageNodeRecord[];
  edges: Array<{
    parentLineageNodeId: string;
    childLineageNodeId: string;
    [key: string]: unknown;
  }>;
  selectedByChannel: Record<string, string>;
  [key: string]: unknown;
}

export interface SessionLineageState extends ProtocolRecord {
  readonly eventCount: number;
  readonly root: SessionLineageNodeRecord | null;
  readonly nodes: Map<string, SessionLineageNodeRecord>;
  readonly summariesByNode: Map<string, SessionLineageSummaryRecord[]>;
  readonly outcomesByNode: Map<string, SessionLineageOutcomeRecord[]>;
  readonly adoptedOutcomesByNode: Map<string, SessionLineageOutcomeAdoptionRecord[]>;
  readonly contextEntries: Map<string, ContextEntryRecord>;
}

export interface TurnInputRecordedPayload extends ProtocolRecord {
  readonly promptText: string;
  readonly turnId: string;
  readonly trigger?: string;
}

export interface TurnRenderCommittedPayload extends ProtocolRecord {
  readonly turnId: string;
  readonly attemptId: string;
  readonly status: "completed" | "failed";
  readonly assistantText: string;
  readonly toolOutputs: readonly ToolOutputView[];
}

export interface TapeLedgerRow extends ProtocolRecord {
  readonly timestamp: number;
  readonly argsSummary: string;
}

export interface SessionCostSkillRow {
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly usageCount: number;
  readonly turns: number;
}

export interface SessionCostToolRow {
  readonly callCount: number;
  readonly allocatedCostUsd: number;
  readonly allocatedTokens: number;
}

export interface SessionCostAlert {
  readonly timestamp: number;
  readonly kind: string;
  readonly scope: string;
  readonly costUsd: number;
  readonly thresholdUsd: number;
}

export interface SessionCostSummary {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalCostUsd: number;
  readonly budget: {
    readonly action: string;
    readonly blocked: boolean;
    readonly [key: string]: unknown;
  };
  readonly skills: Record<string, SessionCostSkillRow>;
  readonly tools: Record<string, SessionCostToolRow>;
  readonly models: Record<
    string,
    {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly totalTokens: number;
      readonly totalCostUsd: number;
      readonly cacheReadTokens?: number;
      readonly [key: string]: unknown;
    }
  >;
  readonly alerts: readonly SessionCostAlert[];
  readonly totals?: ProtocolRecord;
  readonly [key: string]: unknown;
}

export function normalizeAgentId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export interface RecoveryWalRecord extends ProtocolRecord {
  readonly id: string;
  readonly walId: string;
  readonly source: RecoveryWalSource;
  readonly status: RecoveryWalStatus;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly envelope: TurnEnvelope;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly ttlMs?: number;
  readonly attempts?: number;
  readonly lastError?: string;
}

export interface RecoveryWalRecoverySummaryBySource extends ProtocolRecord {
  readonly scanned: number;
  readonly retried: number;
  readonly failed: number;
  readonly expired: number;
}

export interface RecoveryWalRecoveryResult extends ProtocolRecord {
  readonly scanned: number;
  readonly retried: number;
  readonly failed: number;
  readonly expired: number;
  readonly bySource?: Record<string, RecoveryWalRecoverySummaryBySource>;
}

export type RecoveryWalSource = string;

export type RecoveryWalStatus = string;

export interface SessionRewindDivergenceNote extends ProtocolRecord {
  readonly text: string;
  readonly kind: string;
  readonly patchSetCount?: number;
  readonly parentLeafEntryId?: string | null;
}

export interface SessionRewindCompletedPayload extends ProtocolRecord {
  readonly ok?: boolean;
  readonly reasoningRevertEventId?: string;
  readonly summary: "none" | "carry";
  readonly divergenceNote?: SessionRewindDivergenceNote | null;
  readonly returnLeafEntryId?: string | null;
  readonly trigger?: string;
}

export const readSessionRewindCompletedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): SessionRewindCompletedPayload | null => {
  if (!event.payload) {
    return null;
  }
  const payload = event.payload;
  return {
    ...payload,
    summary: payload.summary === "carry" ? "carry" : "none",
  } as SessionRewindCompletedPayload;
};

export const readTurnInputRecordedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): TurnInputRecordedPayload | null =>
  event.payload ? (event.payload as TurnInputRecordedPayload) : null;

export function deriveSessionLineageState(
  events: readonly BrewvaEventRecord[],
): SessionLineageState {
  const nodes = new Map<string, SessionLineageNodeRecord>();
  const summariesByNode = new Map<string, SessionLineageSummaryRecord[]>();
  const outcomesByNode = new Map<string, SessionLineageOutcomeRecord[]>();
  const adoptedOutcomesByNode = new Map<string, SessionLineageOutcomeAdoptionRecord[]>();
  const contextEntries = new Map<string, ContextEntryRecord>();
  let root: SessionLineageNodeRecord | null = null;

  for (const entry of events) {
    const record = typeof entry.payload === "object" && entry.payload !== null ? entry.payload : {};
    const lineageNodeId =
      typeof record.lineageNodeId === "string"
        ? record.lineageNodeId
        : typeof record.nodeId === "string"
          ? record.nodeId
          : undefined;
    if (!lineageNodeId) {
      continue;
    }

    if (entry.type === SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE || "forkPoint" in record) {
      const node: SessionLineageNodeRecord = {
        lineageNodeId,
        parentLineageNodeId:
          typeof record.parentLineageNodeId === "string" ? record.parentLineageNodeId : null,
        kind: typeof record.kind === "string" ? record.kind : "session",
        title: typeof record.title === "string" ? record.title : null,
        eventId: entry.id,
        timestamp: entry.timestamp,
        summaries: Array.isArray(record.summaries) ? record.summaries : [],
        outcomes: Array.isArray(record.outcomes) ? record.outcomes : [],
        adoptedOutcomes: Array.isArray(record.adoptedOutcomes) ? record.adoptedOutcomes : [],
        forkPoint:
          typeof record.forkPoint === "object" && record.forkPoint !== null
            ? (record.forkPoint as ForkPoint)
            : { kind: "session_root" },
      };
      nodes.set(lineageNodeId, node);
      if (!node.parentLineageNodeId) {
        root = node;
      }
      continue;
    }

    if (entry.type === SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE) {
      const list = summariesByNode.get(lineageNodeId) ?? [];
      const summary: SessionLineageSummaryRecord = {
        ...record,
        summaryId: stringField(record, "summaryId", `${entry.id}:summary`),
        lineageNodeId,
        attachToEntryId: stringField(record, "attachToEntryId", entry.id),
        admission: stringField(record, "admission", "admitted"),
        summary: stringField(record, "summary", ""),
        detailsArtifactRef: optionalStringField(record, "detailsArtifactRef") ?? null,
        eventId: entry.id,
        timestamp: entry.timestamp,
      };
      summariesByNode.set(lineageNodeId, [...list, summary]);
      continue;
    }
    if (entry.type === SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE) {
      const list = outcomesByNode.get(lineageNodeId) ?? [];
      const outcome: SessionLineageOutcomeRecord = {
        ...record,
        outcomeId: stringField(record, "outcomeId", `${entry.id}:outcome`),
        lineageNodeId,
        admission: stringField(record, "admission", "admitted"),
        summary: stringField(record, "summary", ""),
        outcomeRef: optionalStringField(record, "outcomeRef") ?? null,
        detailsArtifactRef: optionalStringField(record, "detailsArtifactRef") ?? null,
        eventId: entry.id,
        timestamp: entry.timestamp,
      };
      outcomesByNode.set(lineageNodeId, [...list, outcome]);
      continue;
    }
    if (entry.type === SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE) {
      const list = adoptedOutcomesByNode.get(lineageNodeId) ?? [];
      const adoption: SessionLineageOutcomeAdoptionRecord = {
        ...record,
        adoptionId: stringField(record, "adoptionId", `${entry.id}:adoption`),
        outcomeId: stringField(record, "outcomeId", entry.id),
        fromLineageNodeId: stringField(record, "fromLineageNodeId", lineageNodeId),
        toLineageNodeId: stringField(record, "toLineageNodeId", lineageNodeId),
        admission: stringField(record, "admission", "admitted"),
        summary: optionalStringField(record, "summary") ?? null,
        adoptedEntryId: optionalStringField(record, "adoptedEntryId") ?? null,
        eventId: entry.id,
        timestamp: entry.timestamp,
      };
      adoptedOutcomesByNode.set(lineageNodeId, [...list, adoption]);
      continue;
    }
    if (entry.type === CONTEXT_ENTRY_RECORDED_EVENT_TYPE) {
      const entryId =
        typeof record.entryId === "string" ? record.entryId : `${lineageNodeId}:${entry.id}`;
      const contextEntry: ContextEntryRecord = {
        ...record,
        entryId,
        lineageNodeId,
        parentEntryId: optionalStringField(record, "parentEntryId") ?? null,
        parentLeafEntryId: optionalStringField(record, "parentLeafEntryId") ?? null,
        sourceEventId: stringField(record, "sourceEventId", entry.id),
        sourceEventType: stringField(record, "sourceEventType", entry.type),
        entryKind: stringField(record, "entryKind", "event"),
        admission: stringField(record, "admission", "admitted"),
        presentTo: stringField(record, "presentTo", "model"),
        eventId: entry.id,
        timestamp: entry.timestamp,
        visible: record.visible !== false,
        text: optionalStringField(record, "text"),
        kind: optionalStringField(record, "kind"),
        sourceRefs: readStringArray(record.sourceRefs),
      };
      contextEntries.set(entryId, contextEntry);
    }
  }

  return {
    eventCount: events.length,
    root,
    nodes,
    summariesByNode,
    outcomesByNode,
    adoptedOutcomesByNode,
    contextEntries,
  };
}

export function findSessionLineageRoot(
  tree: SessionLineageTree | SessionLineageState,
): ProtocolRecord | null {
  const root = tree.root ?? null;
  return root && isProtocolRecord(root) ? root : null;
}
