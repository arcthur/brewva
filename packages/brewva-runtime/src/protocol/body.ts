import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BrewvaConfig } from "../config/types.js";
import type { JsonValue, ProtocolRecord } from "./types/foundation.js";
import type {
  PersistedPatchChange,
  PersistedPatchHistory,
  PersistedPatchSet,
} from "./types/patch.js";
import type { SessionRewindTargetView } from "./types/session-rewind.js";

export type { JsonPrimitive, JsonRecord, JsonValue, ProtocolRecord } from "./types/foundation.js";
export * from "./types/patch.js";
export * from "./types/effect-commitment.js";
export * from "./types/session-rewind.js";

export const PATCH_HISTORY_FILE = "patch-history.json" as const;
export const DEFAULT_PATCH_HISTORY_SNAPSHOTS_DIR = "snapshots" as const;

export type ProposalDecision = string;
type UnknownRecord = { readonly [key: string]: unknown };

function isProtocolRecord(value: unknown): value is ProtocolRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: ProtocolRecord, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalStringField(record: ProtocolRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: ProtocolRecord, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function recordArrayField(record: ProtocolRecord, key: string): readonly ProtocolRecord[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isProtocolRecord) : [];
}

export function sanitizePatchHistorySessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function readPatchPathInput(
  rootOrInput: string | ProtocolRecord,
  sessionId?: string,
): { readonly root: string; readonly sessionId: string } {
  if (typeof rootOrInput === "string") {
    return { root: rootOrInput, sessionId: sessionId ?? "default" };
  }
  return {
    root:
      optionalStringField(rootOrInput, "root") ??
      optionalStringField(rootOrInput, "workspaceRoot") ??
      optionalStringField(rootOrInput, "path") ??
      ".",
    sessionId: optionalStringField(rootOrInput, "sessionId") ?? "default",
  };
}

export function resolveSessionPatchHistoryDirectory(
  rootOrInput: string | ProtocolRecord,
  sessionId?: string,
): string {
  const { root, sessionId: resolvedSessionId } = readPatchPathInput(rootOrInput, sessionId);
  return resolve(root, sanitizePatchHistorySessionId(resolvedSessionId));
}

export function resolveSessionPatchHistoryPath(
  rootOrInput: string | ProtocolRecord,
  sessionId?: string,
): string {
  return join(resolveSessionPatchHistoryDirectory(rootOrInput, sessionId), PATCH_HISTORY_FILE);
}

export function readPersistedPatchHistory(path: string): PersistedPatchHistory {
  if (!existsSync(path)) return { patches: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedPatchHistory>;
  return {
    patches: Array.isArray(parsed.patches)
      ? parsed.patches.map((patchSet) =>
          Object.assign({}, patchSet, {
            changes: Array.isArray(patchSet.changes) ? patchSet.changes : [],
          }),
        )
      : [],
  };
}

export function listPersistedPatchSets(pathOrInput: string | ProtocolRecord): PersistedPatchSet[] {
  const path =
    typeof pathOrInput === "string"
      ? pathOrInput
      : (optionalStringField(pathOrInput, "path") ??
        resolveSessionPatchHistoryPath(
          optionalStringField(pathOrInput, "workspaceRoot") ??
            optionalStringField(pathOrInput, "root") ??
            ".",
          optionalStringField(pathOrInput, "sessionId"),
        ));
  return [...readPersistedPatchHistory(path).patches];
}

export function collectPersistedPatchPaths(
  root: string | readonly PersistedPatchSet[],
  options: { readonly ignoredPrefixes?: readonly string[] } = {},
): Set<string> {
  const ignoredPrefixes = options.ignoredPrefixes ?? [];
  const includePath = (path: string): boolean =>
    path.length > 0 && !ignoredPrefixes.some((prefix) => path.startsWith(prefix));
  if (typeof root !== "string") {
    return new Set(
      root.flatMap((patchSet) =>
        (patchSet.changes ?? [])
          .flatMap((change: PersistedPatchChange): readonly unknown[] => [
            change.path,
            change.newPath,
            change.oldPath,
          ])
          .filter((path): path is string => typeof path === "string" && includePath(path)),
      ),
    );
  }
  if (!existsSync(root)) return new Set();
  return new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.name === PATCH_HISTORY_FILE)
      .map((entry) =>
        entry.isDirectory() ? join(root, entry.name, PATCH_HISTORY_FILE) : join(root, entry.name),
      )
      .filter((path) => existsSync(path) && includePath(path)),
  );
}

export {
  ActionPolicyRegistry,
  TOOL_ACTION_CLASSES,
  TOOL_ACTION_POLICY_BY_NAME,
  TOOL_ADMISSION_BEHAVIORS,
  compareToolAdmission,
  createActionPolicyRegistry,
  deriveEffectCommitmentPosture,
  deriveToolGovernanceDescriptor,
  getExactToolActionPolicy,
  getToolActionClassAdmissionBounds,
  getToolActionPolicy,
  getToolActionPolicyForClass,
  getToolActionPolicyResolution,
  getToolGovernanceDescriptor,
  getToolGovernanceResolution,
  resolveEffectiveToolActionPolicy,
  resolveRecoveryPreparationFromPolicy,
  resolveToolAuthority,
  resolveToolExecutionBoundary,
  resolveToolExecutionBoundaryFromEffects,
  resolveToolRecoveryPreparation,
  sameToolActionPolicy,
  toolActionPolicyRequiresApproval,
  toolEffectsRequireEffectCommitment,
  toolGovernanceRequiresEffectCommitment,
  validateToolActionPolicy,
} from "../runtime/kernel/policy/public-contract.js";
export type {
  DeriveEffectCommitmentPostureInput,
  EffectAuthorityManifestBasis,
  EffectCommitmentExecutionEvidence,
  EffectCommitmentPosture,
  EffectPostureEvidenceSource,
  EffectPostureWarning,
  EffectPostureWarningCode,
  EffectProjectionWarning,
  EffectRecoverability,
  EffectVisibility,
  EffectiveToolActionPolicy,
  MutationReceipt,
  MutationSubject,
  PatchSetRedoFailureReason,
  PatchSetRollbackFailureReason,
  ResolvedToolAuthority,
  ToolActionAdmissionOverrides,
  ToolActionClass,
  ToolActionPolicy,
  ToolActionPolicyResolver,
  ToolActionPolicyResolverInput,
  ToolActionPolicyResolution,
  ToolActionPolicySafetyGate,
  ToolActionPolicySource,
  ToolAdmissionBehavior,
  ToolBoxPolicy,
  ToolEffectClass,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  ToolGovernanceDescriptorSource,
  ToolGovernanceResolution,
  ToolGovernanceRisk,
  ToolMutationRollbackFailureReason,
  ToolMutationRollbackKind,
  ToolMutationRollbackResult,
  ToolMutationStrategy,
  ToolReceiptPolicy,
  ToolRecoveryPolicy,
  ToolRecoveryPreparation,
  ToolRiskLevel,
} from "../runtime/kernel/policy/public-contract.js";

export type BrewvaEventDurabilityClass = "canonical" | "advisory" | "ephemeral";
export interface BrewvaEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly turn?: number;
  readonly type: string;
  readonly category?: string;
  readonly timestamp: number;
  readonly isoTime?: string;
  readonly payload?: ProtocolRecord;
  readonly schema?: string;
  readonly source?: string;
  readonly [key: string]: unknown;
}
export interface BrewvaStructuredEvent extends BrewvaEventRecord {}
export interface BrewvaEventQuery {
  readonly sessionId?: string;
  readonly type?: string;
  readonly category?: string;
  readonly since?: number;
  readonly limit?: number;
  readonly after?: number;
  readonly before?: number;
  readonly offset?: number;
  readonly last?: number;
  readonly [key: string]: unknown;
}
export interface BrewvaReplaySession {
  readonly sessionId: string;
  readonly title?: string;
  readonly eventCount: number;
  readonly lastEventAt: number;
  readonly frames?: readonly SessionWireFrame[];
  readonly events?: readonly BrewvaEventRecord[];
  readonly [key: string]: unknown;
}
function payloadOf(
  inputEvent: { readonly payload?: ProtocolRecord; readonly [key: string]: unknown },
  ..._rest: readonly unknown[]
): ProtocolRecord {
  return inputEvent.payload ?? {};
}

function makeEvent(
  type: string,
  payload: ProtocolRecord = {},
  extra: ProtocolRecord = {},
): BrewvaEventRecord {
  const timestamp = Date.now();
  const payloadRecord = payload;
  return Object.freeze({
    id: stringField(extra, "id", `${type}:${timestamp}`),
    sessionId:
      optionalStringField(extra, "sessionId") ??
      optionalStringField(payloadRecord, "sessionId") ??
      "default",
    type,
    payload,
    timestamp,
    isoTime: new Date(timestamp).toISOString(),
    ...extra,
  });
}

export const TURN_ENVELOPE_SCHEMA = "brewva.turn.v1" as const;
export const SESSION_WIRE_SCHEMA = "brewva.session-wire.v2" as const;
export const TASK_LEDGER_SCHEMA = "brewva.task.ledger.v1" as const;
export const CLAIM_LEDGER_SCHEMA = "brewva.claim.ledger.v1" as const;
export const CURRENT_DELEGATION_CONTRACT_VERSION = 3 as const;
export const DEFAULT_SESSION_TITLE = "Untitled session" as const;
export const SESSION_TITLE_MAX_CHARS = 80 as const;
export const CAPABILITY_STATE_INLINE_DATA_MAX_BYTES = 16_384 as const;
export const MAX_REASONING_CONTINUITY_BYTES = 32_768 as const;

export const BOX_ACQUIRED_EVENT_TYPE = "box.acquired" as const;
export const BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE = "box.bootstrap.completed" as const;
export const BOX_BOOTSTRAP_FAILED_EVENT_TYPE = "box.bootstrap.failed" as const;
export const BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE = "box.bootstrap.progress" as const;
export const BOX_BOOTSTRAP_STARTED_EVENT_TYPE = "box.bootstrap.started" as const;
export const BOX_EXEC_COMPLETED_EVENT_TYPE = "box.exec.completed" as const;
export const BOX_EXEC_FAILED_EVENT_TYPE = "box.exec.failed" as const;
export const BOX_EXEC_STARTED_EVENT_TYPE = "box.exec.started" as const;
export const BOX_FORK_CREATED_EVENT_TYPE = "box.fork.created" as const;
export const BOX_MAINTENANCE_COMPLETED_EVENT_TYPE = "box.maintenance.completed" as const;
export const BOX_RELEASED_EVENT_TYPE = "box.released" as const;
export const BOX_SNAPSHOT_CREATED_EVENT_TYPE = "box.snapshot.created" as const;
export const CAPABILITY_STATE_RECORDED_EVENT_TYPE = "capability.state.recorded" as const;
export const CHANNEL_COMMAND_RECEIVED_EVENT_TYPE = "channel.command.received" as const;
export const CHANNEL_SESSION_BOUND_EVENT_TYPE = "channel.session.bound" as const;
export const CHANNEL_SESSION_CONVERSATION_BOUND_EVENT_TYPE =
  "channel.session.conversation.bound" as const;
export const CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE = "channel.update.lock_blocked" as const;
export const CHANNEL_UPDATE_REQUESTED_EVENT_TYPE = "channel.update.requested" as const;
export const CLAIM_EVENT_TYPE = "claim.event" as const;
export const CONTEXT_COMPACTION_ADVISORY_EVENT_TYPE = "context.compaction.advisory" as const;
export const CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE =
  "context.compaction.auto.completed" as const;
export const CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE = "context.compaction.auto.failed" as const;
export const CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE =
  "context.compaction.auto.requested" as const;
export const CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE = "context.compaction.gate.armed" as const;
export const CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE =
  "context.compaction.gate.blocked_tool" as const;
export const CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE =
  "context.compaction.gate.cleared" as const;
export const CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE = "context.compaction.skipped" as const;
export const CONTEXT_COMPOSED_EVENT_TYPE = "context.composed" as const;
export const CONTEXT_ENTRY_RECORDED_EVENT_TYPE = "context.entry.recorded" as const;
export const CRITICAL_WITHOUT_COMPACT_EVENT_TYPE = "context.critical_without_compact" as const;
export const DECISION_RECEIPT_RECORDED_EVENT_TYPE = "decision.receipt.recorded" as const;
export const EFFECT_AUTHORITY_DECIDED_EVENT_TYPE = "effect.authority.decided" as const;
export const EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE =
  "effect.commitment.approval.consumed" as const;
export const EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE =
  "effect.commitment.approval.decided" as const;
export const EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE =
  "effect.commitment.approval.requested" as const;
export const EXEC_FAILED_EVENT_TYPE = "exec.failed" as const;
export const EXEC_STARTED_EVENT_TYPE = "exec.started" as const;
export const FILE_SNAPSHOT_CAPTURED_EVENT_TYPE = "file.snapshot.captured" as const;
export const ITERATION_METRIC_OBSERVED_EVENT_TYPE = "iteration.metric.observed" as const;
export const MESSAGE_END_EVENT_TYPE = "message.end" as const;
export const MODEL_PRESET_SELECT_EVENT_TYPE = "model_preset_select" as const;
export const MODEL_SELECT_EVENT_TYPE = "model_select" as const;
export const OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE =
  "observability.assertion.recorded" as const;
export const OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE = "observability.query.executed" as const;
export const OPERATOR_QUESTION_ANSWERED_EVENT_TYPE = "operator.question.answered" as const;
export const PATCH_RECORDED_EVENT_TYPE = "patch.recorded" as const;
export const PROJECTION_REFRESHED_EVENT_TYPE = "projection.refreshed" as const;
export const REASONING_CHECKPOINT_EVENT_TYPE = "reasoning.checkpoint" as const;
export const REASONING_REVERT_EVENT_TYPE = "reasoning.revert" as const;
export const RECALL_CURATION_RECORDED_EVENT_TYPE = "recall.curation.recorded" as const;
export const RECALL_RESULTS_SURFACED_EVENT_TYPE = "recall.results.surfaced" as const;
export const RECALL_UTILITY_OBSERVED_EVENT_TYPE = "recall.utility.observed" as const;
export const RECOVERY_WAL_APPENDED_EVENT_TYPE = "recovery.wal.appended" as const;
export const RECOVERY_WAL_COMPACTED_EVENT_TYPE = "recovery.wal.compacted" as const;
export const RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE =
  "recovery.wal.recovery.completed" as const;
export const RECOVERY_WAL_STATUS_CHANGED_EVENT_TYPE = "recovery.wal.status.changed" as const;
export const REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE = "reversible_mutation.prepared" as const;
export const REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE = "reversible_mutation.recorded" as const;
export const REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE =
  "reversible_mutation.rolled_back" as const;
export const ROLLBACK_EVENT_TYPE = "rollback.recorded" as const;
export const SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE = "schedule.child_session.failed" as const;
export const SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE =
  "schedule.child_session.finished" as const;
export const SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE = "schedule.child_session.started" as const;
export const SCHEDULE_EVENT_TYPE = "schedule.intent" as const;
export const SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE = "schedule.recovery.deferred" as const;
export const SCHEDULE_WAKEUP_EVENT_TYPE = "schedule.wakeup" as const;
export const SESSION_COMPACT_EVENT_TYPE = "session.compact" as const;
export const SESSION_COMPACT_FAILED_EVENT_TYPE = "session.compact.failed" as const;
export const SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE = "session.compact.request.failed" as const;
export const SESSION_COMPACT_REQUESTED_EVENT_TYPE = "session.compact.requested" as const;
export const SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE = "session.lineage.node.created" as const;
export const SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE =
  "session.lineage.outcome.adopted" as const;
export const SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE =
  "session.lineage.outcome.recorded" as const;
export const SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE =
  "session.lineage.summary.recorded" as const;
export const SESSION_REWIND_COMPLETED_EVENT_TYPE = "session.rewind.completed" as const;
export const SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE = "session.rewind.redo.completed" as const;
export const SESSION_SHUTDOWN_EVENT_TYPE = "session.shutdown" as const;
export const SESSION_TITLE_RECORDED_EVENT_TYPE = "session.title.recorded" as const;
export const SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE =
  "session.unclean_shutdown.reconciled" as const;
export const STEER_APPLIED_EVENT_TYPE = "steer.applied" as const;
export const STEER_DROPPED_EVENT_TYPE = "steer.dropped" as const;
export const STEER_QUEUED_EVENT_TYPE = "steer.queued" as const;
export const SUBAGENT_CANCELLED_EVENT_TYPE = "subagent_cancelled" as const;
export const SUBAGENT_COMPLETED_EVENT_TYPE = "subagent_completed" as const;
export const SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE = "subagent_delivery_surfaced" as const;
export const SUBAGENT_FAILED_EVENT_TYPE = "subagent_failed" as const;
export const SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE =
  "subagent.knowledge_adoption.recorded" as const;
export const SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE = "subagent_outcome_parse_failed" as const;
export const SUBAGENT_RUNNING_EVENT_TYPE = "subagent_running" as const;
export const SUBAGENT_SPAWNED_EVENT_TYPE = "subagent_spawned" as const;
export const TAPE_ANCHOR_EVENT_TYPE = "tape.anchor" as const;
export const TAPE_CHECKPOINT_EVENT_TYPE = "tape.checkpoint" as const;
export const TASK_EVENT_TYPE = "task.event" as const;
export const TASK_STALL_ADJUDICATED_EVENT_TYPE = "task.stall.adjudicated" as const;
export const TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE = "task.stall.error" as const;
export const TASK_STUCK_DETECTED_EVENT_TYPE = "task.stuck.detected" as const;
export const TOOL_CALL_BLOCKED_EVENT_TYPE = "tool.call.blocked" as const;
export const TOOL_CONTRACT_WARNING_EVENT_TYPE = "tool.contract.warning" as const;
export const TOOL_EXECUTION_END_EVENT_TYPE = "tool.execution.end" as const;
export const TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE = "tool.output.artifact.persisted" as const;
export const TOOL_OUTPUT_DISTILLED_EVENT_TYPE = "tool.output.distilled" as const;
export const TOOL_OUTPUT_SEARCH_EVENT_TYPE = "tool.output.search" as const;
export const TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE =
  "tool.read_path.discovery.observed" as const;
export const TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE = "tool.read_path.gate.armed" as const;
export const TOOL_RESULT_RECORDED_EVENT_TYPE = "tool.result.recorded" as const;
export const TURN_INPUT_RECORDED_EVENT_TYPE = "turn.input.recorded" as const;
export const TURN_RENDER_COMMITTED_EVENT_TYPE = "turn.render.committed" as const;
export const VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE = "verification.outcome.recorded" as const;
export const VERIFICATION_STATE_RESET_EVENT_TYPE = "verification.state.reset" as const;
export const VERIFICATION_WRITE_MARKED_EVENT_TYPE = "verification.write.marked" as const;
export const WORKBENCH_BASELINE_COMMITTED_EVENT_TYPE = "workbench.baseline.committed" as const;
export const WORKBENCH_EVICTION_RECORDED_EVENT_TYPE = "workbench.eviction.recorded" as const;
export const WORKBENCH_EVICTION_UNDONE_EVENT_TYPE = "workbench.eviction.undone" as const;
export const WORKBENCH_NOTE_RECORDED_EVENT_TYPE = "workbench.note.recorded" as const;
export const WORKER_RESULTS_APPLIED_EVENT_TYPE = "worker.results.applied" as const;
export const WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE = "worker.results.apply_failed" as const;

export const ITERATION_FACT_SESSION_SCOPE_VALUES = ["session", "turn"] as const;
export const ITERATION_GUARD_STATUS_VALUES = ["pass", "warn", "fail"] as const;
export const ITERATION_METRIC_AGGREGATION_VALUES = ["sum", "max", "last"] as const;
export const TASK_AGENT_ITEM_STATUS_VALUES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
] as const;
export const TASK_AGENT_ITEM_STATUS_RUNTIME_MAP = Object.freeze({
  pending: "pending",
  in_progress: "in_progress",
  completed: "done",
  blocked: "blocked",
});
export const REVIEW_CHANGE_CATEGORIES: readonly string[] = [
  "authn",
  "authz",
  "credential_handling",
  "secret_io",
  "external_input",
  "network_boundary",
  "permission_policy",
  "wal_replay",
  "rollback",
  "scheduler",
  "queueing",
  "async_ordering",
  "cross_session_state",
  "multi_writer_state",
  "cli_surface",
  "config_schema",
  "public_api",
  "export_map",
  "persisted_format",
  "wire_protocol",
  "package_boundary",
  "hot_path",
  "indexing_scan",
  "fanout_parallelism",
  "queue_growth",
  "artifact_volume",
  "storage_churn",
];
export const REVIEW_LANE_NAMES: readonly string[] = [
  "review-correctness",
  "review-boundaries",
  "review-operability",
  "review-security",
  "review-concurrency",
  "review-compatibility",
  "review-performance",
];
export const PLANNING_OWNER_LANES: readonly string[] = ["implementation", "verification", "docs"];
export const REVIEW_REPORT_OUTPUT_CONTRACT = Object.freeze({
  schema: "brewva.skill.review-report.v1",
  required: ["findings", "summary"],
});
export const WORKFLOW_ARTIFACT_KINDS = ["plan", "patch", "verification", "report"] as const;
export const SEMANTIC_ARTIFACT_SCHEMA_IDS = ["review-report", "implementation-plan"] as const;

export type ManagedToolMode = "hosted" | "direct";
export interface ContextBudgetUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
  readonly maxOutputTokens?: number | null;
}
export interface ContextCompactionDecision extends ProtocolRecord {}
export interface ContextStatus extends ProtocolRecord {
  readonly tokensUsed?: number | null;
  readonly tokensTotal?: number | null;
  readonly effectiveTokensTotal?: number | null;
  readonly tokensRemaining?: number | null;
  readonly tokensUntilForcedCompact?: number | null;
  readonly autoCompactLimitTokens?: number | null;
  readonly controllableBaselineTokens?: number | null;
  readonly controllableTokensUsed?: number | null;
  readonly controllableTokensRemaining?: number | null;
  readonly controllableTokensTotal?: number | null;
  readonly controllableContextRemainingRatio?: number | null;
  readonly predictedTurnGrowthTokens?: number | null;
  readonly tokensUntilPredictedOverflow?: number | null;
  readonly predictedOverflow?: boolean;
  readonly usageRatio: number | null;
  readonly hardLimitRatio: number;
  readonly compactionThresholdRatio: number;
  readonly compactionAdvised: boolean;
  readonly forcedCompaction: boolean;
}
export interface ContextCompactionGateStatus extends ProtocolRecord {
  readonly status: ContextStatus;
  readonly required?: boolean;
  readonly reason?: string | null;
  readonly recentCompaction?: boolean;
  readonly windowTurns?: number | null;
  readonly lastCompactionTurn?: number | null;
  readonly turnsSinceCompaction?: number | null;
}
export type ContextCompactionReason = string;
export type ContextEvidenceKind = string;
export interface ContextEvidenceSample {
  readonly kind: ContextEvidenceKind;
  readonly turn: number;
  readonly timestamp: number;
  readonly payload: {
    readonly scopeKey?: string;
    readonly stablePrefixHash?: string;
    readonly dynamicTailHash?: string;
    readonly stablePrefix?: boolean;
    readonly stableTail?: boolean;
    readonly status?: string;
    readonly reason?: string | null;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly bucketKey?: string;
    readonly visibleHistoryReductionHash?: string;
    readonly workbenchContextHash?: string;
    readonly eligibleToolResults?: number;
    readonly clearedToolResults?: number;
    readonly clearedChars?: number;
    readonly estimatedTokenSavings?: number;
    readonly compactionAdvised?: boolean;
    readonly forcedCompaction?: boolean;
    readonly classification?: string | null;
    readonly expectedCacheBreak?: boolean;
    readonly source?: string;
    readonly provider?: string;
    readonly api?: string;
    readonly model?: string;
  };
}
export interface ContextStatusView extends ContextStatus {}
export type ContextAdmission = string;
export type ContextEntryPresentTo = string;
export interface ContextEntryRecord extends ProtocolRecord {
  readonly entryId: string;
  readonly lineageNodeId: string;
  readonly parentEntryId: string | null;
  readonly parentLeafEntryId?: string | null;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
  readonly entryKind: string;
  readonly admission: string;
  readonly presentTo: string;
  readonly eventId: string;
  readonly timestamp: number;
  readonly visible?: boolean;
  readonly text?: string;
  readonly kind?: string;
  readonly sourceRefs?: readonly string[];
}
export interface ExpectedProviderCacheBreak {
  readonly classification: string;
  readonly reason: string | null;
}
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
export type HistoryViewBaselineOrigin = string;
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
export interface ParallelAcquireResult extends ProtocolRecord {}
export interface PromptStabilityObservationInput extends ProtocolRecord {}
export interface PromptStabilityState extends ProtocolRecord {
  readonly turn: number;
  readonly updatedAt: number;
  readonly scopeKey: string;
  readonly stablePrefixHash: string;
  readonly dynamicTailHash: string;
  readonly stablePrefix: boolean;
  readonly stableTail: boolean;
}
export type ProviderCacheBreakClassification = string;
export interface ProviderCacheBreakObservation {
  readonly status: "cold" | "warm" | "break" | "limited";
  readonly classification: string;
  readonly expected: boolean;
  readonly reason: string | null;
  readonly previousCacheReadTokens?: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheMissTokens: number;
  readonly changedFields: readonly string[];
  readonly thresholdTokens?: number;
  readonly relativeDropThreshold?: number;
}
export interface ProviderCacheCapabilityState extends ProtocolRecord {}
export type ProviderCacheCapabilityStrategy = string;
export type ProviderCacheRetention = "none" | "short" | "long";
export type ProviderCacheStrategy =
  | "explicitCacheMarker"
  | "explicitCachedContent"
  | "promptCacheKey"
  | "implicitPrefix"
  | "unsupported";
export type ProviderCacheCounterSupport = "readWrite" | "readOnly" | "none";
export type ProviderCacheLongRetention = "none" | "1h" | "24h";
export type ProviderCacheReadOnlyWriteMode = "supported" | "unsupported";
export type ProviderSessionContinuationFamily = "openai-responses";
export type ProviderSessionContinuationMode =
  | "websocketConnection"
  | "previousResponseId"
  | "turnStateHeader";
export interface ProviderSessionContinuationCapability {
  readonly family: ProviderSessionContinuationFamily;
  readonly modes: ProviderSessionContinuationMode[];
  readonly authority: "efficiency";
  readonly reason: string;
}
export interface ProviderCacheCapability {
  readonly strategies: ProviderCacheStrategy[];
  readonly cacheCounters: ProviderCacheCounterSupport;
  readonly shortRetention: boolean;
  readonly longRetention: ProviderCacheLongRetention;
  readonly readOnlyWriteMode: ProviderCacheReadOnlyWriteMode;
  readonly continuation?: ProviderSessionContinuationCapability;
  readonly reason: string;
}
export type ProviderCacheRenderStatus = "rendered" | "disabled" | "unsupported" | "degraded";
export interface ProviderCacheRenderResult {
  readonly status: ProviderCacheRenderStatus;
  readonly reason: string;
  readonly renderedRetention: ProviderCacheRetention;
  readonly bucketKey: string;
  readonly capability?: ProviderCacheCapability;
  readonly cachedContentName?: string;
  readonly cachedContentTtlSeconds?: number;
}
export type ProviderCacheRenderState = ProviderCacheRenderResult;
export interface ProviderCacheFingerprintState {
  readonly bucketKey?: string;
  readonly stablePrefixHash?: string;
  readonly dynamicTailHash?: string;
  readonly visibleHistoryReductionHash?: string;
  readonly workbenchContextHash?: string;
}
export interface ProviderCacheObservationInput {
  readonly turn?: number;
  readonly timestamp?: number;
  readonly source: string;
  readonly fingerprint: ProviderCacheFingerprintState;
  readonly render?: ProviderCacheRenderState;
  readonly breakObservation: ProviderCacheBreakObservation;
}
export interface ProviderCacheObservationState extends ProtocolRecord {
  readonly turn: number;
  readonly updatedAt: number;
  readonly source: string;
  readonly fingerprint: ProviderCacheFingerprintState;
  readonly render?: ProviderCacheRenderState;
  readonly breakObservation: ProviderCacheBreakObservation;
}
export interface ProviderSessionContinuationCapabilityState extends ProtocolRecord {}
export type RecoveryPendingFamily = string;
export type RecoveryPostureMode = string;
export interface RecoveryPostureSnapshot extends ProtocolRecord {}
export interface RecoveryWorkingSetSnapshot extends ProtocolRecord {}
export interface ResourceLeaseBudget extends ProtocolRecord {
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
  readonly maxParallel?: number;
}
export interface ResourceLeaseCancelResult extends ProtocolRecord {}
export interface ResourceLeaseQuery extends ProtocolRecord {}
export interface ResourceLeaseRecord extends ProtocolRecord {
  readonly id: string;
  readonly status: string;
  readonly skillName?: string;
  readonly budget: ResourceLeaseBudget;
  readonly expiresAt?: string | null;
  readonly expiresAfterTurn?: number | null;
  readonly reason?: string;
}
export interface ResourceLeaseRequest extends ProtocolRecord {}
export interface ResourceLeaseResult extends ProtocolRecord {}
export interface SessionCompactionCacheImpact extends ProtocolRecord {}
export interface SessionCompactionCacheImpactSnapshot extends ProtocolRecord {}
export interface SessionCompactionCommitInput extends ProtocolRecord {}
export interface SessionCompactionGenerationMetadata extends ProtocolRecord {}
export type SessionCompactionOrigin = string;
export interface TapeAnchorState extends ProtocolRecord {}
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
export interface ToolAccessResult extends ProtocolRecord {}
export interface TransientReductionObservationInput extends ProtocolRecord {
  readonly turn?: number;
  readonly timestamp?: number;
  readonly status: "completed" | "skipped";
  readonly reason?: string | null;
  readonly eligibleToolResults: number;
  readonly clearedToolResults: number;
  readonly clearedChars?: number;
  readonly estimatedTokenSavings?: number;
  readonly compactionAdvised?: boolean;
  readonly forcedCompaction?: boolean;
  readonly classification?: string | null;
  readonly expectedCacheBreak?: boolean;
}
export interface TransientReductionState extends ProtocolRecord {
  readonly turn: number;
  readonly updatedAt: number;
  readonly status: "completed" | "skipped";
  readonly reason: string | null;
  readonly eligibleToolResults: number;
  readonly clearedToolResults: number;
  readonly clearedChars: number;
  readonly estimatedTokenSavings: number;
  readonly compactionAdvised: boolean;
  readonly forcedCompaction: boolean;
  readonly classification?: string | null;
  readonly expectedCacheBreak?: boolean;
}
export interface VisibleReadState extends ProtocolRecord {}
export interface ToolOutputDisplayView extends ProtocolRecord {
  summaryText?: string;
  detailsText?: string;
  rawText?: string;
}
export interface AssistantTextSegmentView extends ProtocolRecord {
  readonly text: string;
  readonly ts: number;
  readonly sourceEventId?: string;
}
export interface ToolOutputView extends ProtocolRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly verdict: string;
  readonly isError: boolean;
  readonly text: string;
  readonly ts?: number;
  readonly sourceEventId?: string;
  readonly display?: ToolOutputDisplayView;
}
export interface ToolLifecycleEventPayload extends ProtocolRecord {}
export interface ToolCallBlockedEventPayload extends ProtocolRecord {}
export interface ToolResultRecordedEventPayload extends ProtocolRecord {
  readonly failureClass: string;
  readonly toolName: string;
  readonly ledgerId?: string;
  readonly verdict?: string;
  readonly failureContext?: ToolOutputDistilledEventPayload | null;
}
export type ToolResultFailureClass = string;
export interface ToolResultFailureContextPayload extends ProtocolRecord {}
export type ToolResultVerdict = string;
export interface SessionTitleRecordedPayload extends ProtocolRecord {}
export interface SessionTitleRecordedModel extends ProtocolRecord {}
export type SessionTitleSource = string;
export interface SessionTitleView extends ProtocolRecord {}
export interface SessionUncleanShutdownDiagnostic extends ProtocolRecord {
  readonly detectedAt: number;
  readonly reasons: readonly string[];
  readonly openToolCalls: readonly OpenToolCallRecord[];
  readonly openTurns?: readonly OpenTurnRecord[];
  readonly latestEventType?: string;
}
export type SessionUncleanShutdownReason = string;
export interface SessionUncleanShutdownReconciledPayload extends ProtocolRecord {}
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
export interface SessionLifecycleRecoverySnapshot extends ProtocolRecord {}
export interface SessionLifecycleSnapshotBuildInput extends ProtocolRecord {}
export type SessionLifecycleSummaryKind = string;
export interface SessionLifecycleSummarySnapshot extends ProtocolRecord {}
export interface SessionLifecycleToolingSnapshot extends ProtocolRecord {}
export interface SessionLifecycleTransitionSnapshot extends ProtocolRecord {}
export interface CreateBrewvaSessionOptions {
  readonly cwd?: string;
  readonly model?: string;
  readonly configPath?: string;
  readonly config?: BrewvaConfig;
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
export interface RecordGeneratedSessionTitleInput extends ProtocolRecord {}
export interface SessionHydrationState extends ProtocolRecord {}
export type IntegrityDomain = string;
export interface IntegrityIssue extends ProtocolRecord {}
export type IntegritySeverity = string;
export type IntegrityStatus = string;
export type ForkPoint =
  | { kind: "session_root"; parentSessionId?: string | null }
  | { kind: "reasoning_checkpoint"; reasoningCheckpointId: string }
  | { kind: "turn"; turnId: string }
  | { kind: "context_entry"; lineageNodeId: string; entryId: string }
  | { kind: "tool_call"; toolCallId: string }
  | { kind: "patch_set"; patchSetId: string }
  | { kind: "worker_run"; workerRunId: string };
export interface AdoptSessionLineageOutcomeInput extends ProtocolRecord {}
export interface CapabilityStateRecordedPayload extends ProtocolRecord {}
export interface CapabilityStateRecord extends ProtocolRecord {}
export type ContextEntryRecordedPayload = ContextEntryRecord;
export interface CreateSessionLineageNodeInput extends ProtocolRecord {}
export interface GetContextEntryPathInput extends ProtocolRecord {}
export interface LineageOutcomeAdmission extends ProtocolRecord {}
export interface RecordCapabilityStateInput extends ProtocolRecord {}
export interface RecordContextEntryInput extends ProtocolRecord {}
export interface RecordSessionLineageOutcomeInput extends ProtocolRecord {}
export interface RecordSessionLineageSelectionInput extends ProtocolRecord {}
export interface RecordSessionLineageSummaryInput extends ProtocolRecord {}
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
export interface SessionLineageNodeCreatedPayload extends ProtocolRecord {}
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
export interface SessionLineageOutcomeAdoptedPayload extends ProtocolRecord {}
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
export interface SessionLineageOutcomeRecordedPayload extends ProtocolRecord {}
export interface SessionLineageSelectionRecord extends ProtocolRecord {}
export interface SessionLineageSelectionRecordedPayload extends ProtocolRecord {}
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
export interface SessionLineageSummaryRecordedPayload extends ProtocolRecord {}
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
export interface SessionLineageNodeView extends ProtocolRecord {}
export interface SessionLineageEdge extends ProtocolRecord {}
export type SessionLineageNodeKind = string;
export interface TurnInputRecordedPayload extends ProtocolRecord {
  readonly promptText: string;
  readonly turnId: string;
  readonly trigger?: string;
}
export interface TurnRenderCommittedPayload extends ProtocolRecord {}
export type ReasoningCheckpointBoundary = string;
export interface ReasoningRevertInput extends ProtocolRecord {}
export type ReasoningRevertTrigger = string;
export interface RecordReasoningCheckpointInput extends ProtocolRecord {}
export interface ReasoningCheckpointRecord extends ProtocolRecord {
  readonly checkpointId: string;
  readonly branchId: string;
  readonly boundary: string;
  readonly leafEntryId?: string | null;
}
export interface ReasoningRevertRecord extends ProtocolRecord {
  readonly revertId: string;
  readonly toCheckpointId: string;
  readonly fromCheckpointId?: string | null;
  readonly trigger: string;
  readonly newBranchId: string;
}
export interface ActiveReasoningBranchState extends ProtocolRecord {
  readonly activeBranchId: string;
  readonly activeCheckpointId?: string | null;
  readonly activeLineageCheckpointIds: readonly string[];
  readonly checkpoints: readonly ReasoningCheckpointRecord[];
  readonly reverts: readonly ReasoningRevertRecord[];
}
export interface WorkbenchEntry extends ProtocolRecord {
  readonly id?: string;
  readonly kind?: string;
  readonly digest: string;
  readonly content?: string;
  readonly text?: string;
  readonly preservedQuotes?: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly reason: string;
  readonly createdTurn?: number;
  readonly reversible?: boolean;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}
export type WorkbenchEntryKind = string;
export interface WorkbenchEvictInput extends ProtocolRecord {}
export type WorkbenchEvictionSpanRefPrefix = string;
export interface WorkbenchNoteInput extends ProtocolRecord {}
export interface WorkbenchUndoEvictionResult extends ProtocolRecord {}
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
export interface SessionCostTotals extends ProtocolRecord {}
export interface EvidenceQuery extends ProtocolRecord {}
export interface EvidenceRecord extends ProtocolRecord {}
export interface LedgerDigest extends ProtocolRecord {}
export interface EvidenceDiversityCluster extends ProtocolRecord {}
export interface EvidenceDiversitySummary extends ProtocolRecord {}
export type EvidencePolarity = string;
export interface EvidenceRef extends ProtocolRecord {}
export type EvidenceSourceType = string;
export type EvidenceTrustLevel = string;
export interface EvidenceArtifact extends ProtocolRecord {}
export type CommandFailureClass = string;
export interface TscDiagnostic {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
  readonly code: string;
  readonly severity?: TscDiagnosticSeverity;
  readonly [key: string]: unknown;
}
export type TscDiagnosticSeverity = string;

export type TurnPart =
  | ({
      readonly type: "text";
      readonly text: string;
      readonly uri?: string;
      readonly name?: string;
    } & Record<string, unknown>)
  | ({
      readonly type: string;
      readonly text?: string;
      readonly uri?: string;
      readonly name?: string;
    } & Record<string, unknown>);
export interface TurnEnvelope {
  readonly schema: typeof TURN_ENVELOPE_SCHEMA;
  readonly id?: string;
  readonly channelId?: string;
  readonly channel: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly turnId: string;
  readonly threadId?: string;
  readonly timestamp?: number;
  readonly kind: TurnKind;
  readonly parts: readonly TurnPart[];
  readonly approval?: ApprovalPayload;
  readonly createdAt?: string;
  readonly meta?: ProtocolRecord & { readonly deliveryPlan?: TurnDeliveryPlan };
  readonly [key: string]: unknown;
}
export type TurnKind = string;
export type ApprovalAction = string;
export interface ApprovalPayload {
  readonly requestId: string;
  readonly title: string;
  readonly detail?: string;
  readonly actions: Array<{ id: string; label: string; style?: string }>;
  readonly [key: string]: unknown;
}
export interface AdapterRegistration extends ProtocolRecord {}
export interface AdapterSendResult extends ProtocolRecord {
  readonly providerMessageId?: string | null;
}
export interface AdapterStartContext {
  readonly onTurn: (turn: TurnEnvelope) => Promise<void>;
}
export type BuildTurnEnvelopeInput = Partial<TurnEnvelope> & {
  readonly parts?: readonly TurnPart[];
};
export interface ChannelCapabilities extends ProtocolRecord {
  readonly streaming?: boolean;
  readonly inlineActions?: boolean;
  readonly codeBlocks?: boolean;
  readonly multiModal?: boolean;
  readonly threadedReplies?: boolean;
}
export interface ChannelCapabilityParams {
  readonly conversationId: string;
  readonly [key: string]: unknown;
}
export interface TurnStreamWriter {
  write(chunk: string): void;
}
export interface ChannelAdapter {
  readonly id?: string;
  readonly capabilities?: (params: ChannelCapabilityParams) => ChannelCapabilities;
  readonly start?: (context: AdapterStartContext) => unknown;
  readonly stop?: (context?: unknown) => unknown;
  readonly deliver?: (turn: TurnEnvelope) => AdapterSendResult | Promise<AdapterSendResult>;
  readonly sendTurn?: (turn: TurnEnvelope) => AdapterSendResult | Promise<AdapterSendResult>;
  readonly sendTurnStream?: (
    turn: TurnEnvelope,
    stream: TurnStreamWriter,
  ) => AdapterSendResult | Promise<AdapterSendResult>;
}
export interface ChannelTurnEmittedInput {
  readonly requestedTurn: TurnEnvelope;
  readonly deliveredTurn: TurnEnvelope;
  readonly result: AdapterSendResult;
}

export interface TurnBridgeHandlers {
  readonly deliver?: (...args: readonly unknown[]) => unknown;
  readonly sendTurn?: (...args: readonly unknown[]) => unknown;
  readonly start?: (...args: readonly unknown[]) => unknown;
  readonly stop?: (...args: readonly unknown[]) => unknown;
  readonly onInboundTurn?: (turn: TurnEnvelope) => unknown;
  readonly onAdapterError?: (error: unknown) => unknown;
  readonly onTurnEmitted?: (input: ChannelTurnEmittedInput) => void | Promise<void>;
  readonly onTurnIngested?: (turn: TurnEnvelope) => unknown;
  readonly onStreamChunk?: (turn: TurnEnvelope, chunk: string) => unknown;
  readonly [key: string]: unknown;
}
export interface TurnDeliveryPlan extends ProtocolRecord {
  readonly streamMode: "stream" | "buffered";
  readonly approvalMode: "inline" | "text" | "none";
  readonly codeBlockMode: "native" | "plain_text";
  readonly mediaMode: "native" | "link_only";
  readonly threadMode: "native" | "prepend_context";
}
export type TurnEnvelopeCoerceResult =
  | { readonly ok: true; readonly envelope: TurnEnvelope }
  | { readonly ok: false; readonly reason: string };
export interface TurnStreamEmitter extends ProtocolRecord {}

export const DEFAULT_CHANNEL_CAPABILITIES = Object.freeze({
  streaming: true,
  inlineActions: true,
  codeBlocks: true,
  multiModal: true,
  threadedReplies: true,
});

export interface ChannelAdapterRegistration {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly create: () => ChannelAdapter;
}

export class ChannelAdapterRegistry {
  private readonly registrations = new Map<string, ChannelAdapterRegistration>();
  private readonly aliases = new Map<string, string>();

  register(registration: ChannelAdapterRegistration): void {
    const id = normalizeChannelId(registration.id);
    if (!id) {
      throw new Error("adapter id is required");
    }
    if (this.registrations.has(id) || this.aliases.has(id)) {
      throw new Error(`adapter already registered: ${id}`);
    }
    for (const aliasValue of registration.aliases ?? []) {
      const alias = normalizeChannelId(aliasValue);
      if (!alias) continue;
      if (this.registrations.has(alias) || this.aliases.has(alias)) {
        throw new Error(`adapter already registered: ${alias}`);
      }
    }

    const normalizedAliases = (registration.aliases ?? [])
      .map(normalizeChannelId)
      .filter((alias): alias is string => alias.length > 0);
    this.registrations.set(id, { ...registration, id, aliases: normalizedAliases });
    for (const alias of normalizedAliases) {
      this.aliases.set(alias, id);
    }
  }

  unregister(id: string): boolean {
    const resolved = this.resolveId(id);
    if (!resolved) {
      return false;
    }
    const registration = this.registrations.get(resolved);
    this.registrations.delete(resolved);
    for (const alias of registration?.aliases ?? []) {
      this.aliases.delete(alias);
    }
    return true;
  }

  resolveId(id: string): string | undefined {
    const normalized = normalizeChannelId(id);
    if (this.registrations.has(normalized)) {
      return normalized;
    }
    return this.aliases.get(normalized);
  }

  createAdapter(id: string): ChannelAdapter | undefined {
    const resolved = this.resolveId(id);
    if (!resolved) {
      return undefined;
    }
    const registration = this.registrations.get(resolved);
    const adapter = registration?.create();
    if (!adapter) {
      return undefined;
    }
    const adapterId = normalizeChannelId((adapter as UnknownRecord).id);
    if (adapterId !== resolved) {
      throw new Error(`adapter id mismatch: expected ${resolved}, got ${adapterId}`);
    }
    return adapter;
  }

  get(id: string): ChannelAdapter | undefined {
    return this.createAdapter(id);
  }

  list(): readonly { readonly id: string }[] {
    return [...this.registrations.keys()].toSorted().map((id) => ({ id }));
  }
}

export class ChannelTurnBridge {
  readonly adapter?: ChannelAdapter;
  readonly handlers: TurnBridgeHandlers;
  #running = false;
  constructor(
    adapterOrHandlers: ChannelAdapter | TurnBridgeHandlers = {},
    handlers: TurnBridgeHandlers = {},
  ) {
    this.adapter =
      handlers && Object.keys(handlers).length > 0
        ? (adapterOrHandlers as ChannelAdapter)
        : undefined;
    this.handlers = this.adapter ? handlers : (adapterOrHandlers as TurnBridgeHandlers);
  }
  isRunning(): boolean {
    return this.#running;
  }

  async start(input?: unknown): Promise<unknown> {
    if (this.#running) {
      return { started: true };
    }
    const handler = (this.handlers as UnknownRecord).start;
    if (typeof handler === "function") {
      const result = await handler(input);
      this.#running = true;
      return result;
    }
    const context: AdapterStartContext = {
      ...(typeof input === "object" && input !== null ? (input as UnknownRecord) : {}),
      onTurn: async (turn: TurnEnvelope) => {
        await this.handlers.onInboundTurn?.(turn);
        await this.handlers.onTurnIngested?.(turn);
      },
    };
    const result =
      typeof this.adapter?.start === "function" ? await this.adapter.start(context) : undefined;
    this.#running = true;
    return result ?? { started: true };
  }
  async stop(input?: unknown): Promise<unknown> {
    if (!this.#running) {
      return { stopped: true };
    }
    const handler = (this.handlers as UnknownRecord).stop;
    if (typeof handler === "function") {
      const result = await handler(input);
      this.#running = false;
      return result;
    }
    const result =
      typeof this.adapter?.stop === "function" ? await this.adapter.stop(input) : undefined;
    this.#running = false;
    return result ?? { stopped: true };
  }
  async sendTurn(...args: unknown[]): Promise<AdapterSendResult> {
    const handler =
      (this.handlers as UnknownRecord).sendTurn ?? (this.handlers as UnknownRecord).deliver;
    if (typeof handler === "function") {
      const result = await handler(...args);
      return isProtocolRecord(result) ? result : { delivered: true };
    }
    const requestedTurn = args[0] as TurnEnvelope;
    const capabilities =
      this.adapter?.capabilities?.({ conversationId: requestedTurn.conversationId }) ??
      DEFAULT_CHANNEL_CAPABILITIES;
    const deliveredTurn = prepareTurnForDelivery(requestedTurn, capabilities);
    try {
      let result: AdapterSendResult;
      if (capabilities.streaming && typeof this.adapter?.sendTurnStream === "function") {
        result = await this.adapter.sendTurnStream(deliveredTurn, {
          write: (chunk: string) => {
            void this.handlers.onStreamChunk?.(deliveredTurn, chunk);
          },
        });
      } else if (typeof this.adapter?.sendTurn === "function") {
        result = await this.adapter.sendTurn(deliveredTurn);
      } else {
        result = { delivered: true };
      }
      await this.handlers.onTurnEmitted?.({ requestedTurn, deliveredTurn, result });
      return result;
    } catch (error) {
      await this.handlers.onAdapterError?.(error);
      throw error;
    }
  }
  async deliver(envelope: TurnEnvelope): Promise<AdapterSendResult> {
    const handler = (this.handlers as UnknownRecord).deliver;
    if (typeof handler === "function") {
      return await handler(envelope);
    }
    if (typeof this.adapter?.deliver === "function") {
      return await this.adapter.deliver(envelope);
    }
    return await this.sendTurn(envelope);
  }
}

export function normalizeChannelId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeAgentId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function requireNonEmptyChannelToken(label: string, value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function coerceContextBudgetUsage(value: unknown): ContextBudgetUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as ProtocolRecord;
  const contextWindow = finiteNumber(record.contextWindow);
  if (contextWindow === null || contextWindow <= 0) {
    return undefined;
  }
  const tokens = finiteNumber(record.tokens);
  const percent = finiteNumber(record.percent);
  const maxOutputTokens = finiteNumber(record.maxOutputTokens);
  return {
    tokens: tokens === null || tokens < 0 ? null : tokens,
    contextWindow,
    percent: percent === null || percent < 0 ? null : percent,
    maxOutputTokens: maxOutputTokens === null || maxOutputTokens <= 0 ? null : maxOutputTokens,
  };
}

export function buildRawConversationKey(input: {
  readonly channelId: string;
  readonly conversationId: string;
}): string {
  const channel = normalizeChannelId(requireNonEmptyChannelToken("channel", input.channelId));
  const conversationId = requireNonEmptyChannelToken("conversationId", input.conversationId);
  return `${channel}:${conversationId}`;
}

export function buildChannelSessionId(
  input: string | { readonly channelId: string; readonly conversationId: string },
  conversationId?: string,
): string {
  if (typeof input === "string" && conversationId !== undefined) {
    const channel = normalizeChannelId(requireNonEmptyChannelToken("channel", input));
    const normalizedConversationId = requireNonEmptyChannelToken("conversationId", conversationId);
    return `channel:${channel}:${normalizedConversationId}`;
  }
  if (typeof input === "string") return `channel:${requireNonEmptyChannelToken("channel", input)}`;
  return `channel:${buildRawConversationKey(input)}`;
}

export function buildChannelDedupeKey(input: unknown, ...parts: unknown[]): string {
  if (parts.length > 0) {
    const labels = ["channel", "conversationId", "messageId"];
    return [input, ...parts]
      .map((part, index) => requireNonEmptyChannelToken(labels[index] ?? "part", part))
      .join(":");
  }
  if (typeof input !== "object" || input === null) {
    return typeof input === "string" ? input : input == null ? "" : JSON.stringify(input);
  }
  const record = input as ProtocolRecord;
  return [record.channelId, record.conversationId, record.messageId, record.id]
    .filter(Boolean)
    .join(":");
}

export function normalizeTurnParts(
  parts: readonly TurnPart[] | string | undefined,
): readonly TurnPart[] {
  if (typeof parts === "string") return [{ type: "text", text: parts }];
  return parts ?? [];
}

export function buildTurnEnvelope(
  input: BuildTurnEnvelopeInput,
  ..._rest: unknown[]
): TurnEnvelope {
  const envelope = {
    schema: TURN_ENVELOPE_SCHEMA,
    channel: input.channel ?? input.channelId ?? "",
    conversationId: input.conversationId ?? "",
    sessionId: input.sessionId ?? "",
    turnId: input.turnId ?? "",
    kind: input.kind ?? "message",
    parts: normalizeTurnParts(input.parts),
    ...input,
  };
  return Object.freeze(envelope);
}

export function coerceTurnEnvelope(value: unknown, ..._rest: unknown[]): TurnEnvelopeCoerceResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "invalid_turn_envelope:not_object" };
  }
  const candidate = value as ProtocolRecord;
  if (candidate.schema !== undefined && candidate.schema !== TURN_ENVELOPE_SCHEMA) {
    return { ok: false, reason: "invalid_turn_envelope:invalid_schema" };
  }
  const missing = ["sessionId", "turnId", "channel", "conversationId"].filter((key) => {
    const candidateValue = candidate[key];
    return typeof candidateValue !== "string" || candidateValue.trim().length === 0;
  });
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `invalid_turn_envelope:${missing.map((key) => `missing_${key}`).join(",")}`,
    };
  }
  return { ok: true, envelope: buildTurnEnvelope(candidate) };
}

export function assertTurnEnvelope(value: unknown): asserts value is TurnEnvelope {
  const result = coerceTurnEnvelope(value);
  if (!result.ok) throw new Error(result.reason);
}

function stripCodeFence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(text.trim());
  return match?.[1] ?? text;
}

function textForLinkedPart(part: TurnPart): string {
  const label =
    part.type === "file" && typeof part.name === "string" && part.name.trim().length > 0
      ? `file (${part.name})`
      : part.type;
  return `[${label}] ${part.uri ?? ""}`.trim();
}

function approvalText(approval: ApprovalPayload | undefined): string | null {
  if (!approval) return null;
  const actions = approval.actions.map((action) => action.id).join(", ");
  return [
    approval.title,
    approval.detail,
    actions.length > 0 ? `Reply with one of: ${actions}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

export function prepareTurnForDelivery(
  envelope: TurnEnvelope,
  capabilities: ChannelCapabilities = DEFAULT_CHANNEL_CAPABILITIES,
): TurnEnvelope {
  const plan = resolveTurnDeliveryPlan(envelope, capabilities);
  const parts: TurnPart[] = [];
  for (const part of envelope.parts) {
    if (part.type === "text") {
      const text =
        plan.codeBlockMode === "plain_text" && typeof part.text === "string"
          ? stripCodeFence(part.text)
          : part.text;
      parts.push({ ...part, text });
      continue;
    }
    if ((part.type === "image" || part.type === "file") && plan.mediaMode === "link_only") {
      parts.push({ type: "text", text: textForLinkedPart(part) });
      continue;
    }
    parts.push(part);
  }
  if (plan.threadMode === "prepend_context" && envelope.threadId && parts[0]?.type === "text") {
    parts[0] = { ...parts[0], text: `[thread:${envelope.threadId}]\n${parts[0].text ?? ""}` };
  }
  if (plan.approvalMode === "text") {
    const text = approvalText(envelope.approval);
    if (text) {
      parts.push({ type: "text", text });
    }
  }
  return buildTurnEnvelope({
    ...envelope,
    parts,
    meta: {
      ...envelope.meta,
      deliveryPlan: plan,
    },
  });
}

export function resolveChannelCapabilities(input: ChannelCapabilities = {}): ChannelCapabilities {
  return Object.freeze({ ...DEFAULT_CHANNEL_CAPABILITIES, ...input });
}

export function resolveTurnDeliveryPlan(
  input: TurnEnvelope,
  capabilities: ChannelCapabilities = DEFAULT_CHANNEL_CAPABILITIES,
): TurnDeliveryPlan {
  const caps = resolveChannelCapabilities(capabilities);
  const approvalMode =
    input.approval || input.kind === "approval"
      ? caps.inlineActions === false
        ? "text"
        : "inline"
      : "none";
  return Object.freeze({
    streamMode: caps.streaming === false ? "buffered" : "stream",
    approvalMode,
    codeBlockMode: caps.codeBlocks === false ? "plain_text" : "native",
    mediaMode: caps.multiModal === false ? "link_only" : "native",
    threadMode: caps.threadedReplies === false ? "prepend_context" : "native",
  });
}

export type SessionWireSource = "live" | "replay";
export type SessionWireDurability = "cache" | "durable";
export type SessionWireStatusState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "restarting"
  | "error"
  | "closed";
export interface SessionWireFrameBase extends ProtocolRecord {
  readonly schema: typeof SESSION_WIRE_SCHEMA;
  readonly sessionId: string;
  readonly frameId: string;
  readonly ts: number;
  readonly source: SessionWireSource;
  readonly durability: SessionWireDurability;
  readonly sourceEventId?: string;
  readonly sourceEventType?: string;
}
export type SessionWireFrame =
  | (SessionWireFrameBase & {
      readonly type: "replay.begin" | "replay.complete";
    })
  | (SessionWireFrameBase & {
      readonly type: "session.status";
      readonly state: SessionWireStatusState;
      readonly reason?: string;
      readonly detail?: string;
      readonly contextStatus?: ContextStatusView;
    })
  | (SessionWireFrameBase & {
      readonly type: "turn.input";
      readonly turnId: string;
      readonly promptText: string;
      readonly trigger: SessionWireTurnTrigger;
    })
  | (SessionWireFrameBase & {
      readonly type: "turn.transition";
      readonly turnId: string;
      readonly reason: string;
      readonly status: SessionWireTransitionStatus;
      readonly family: SessionWireTransitionFamily;
      readonly attempt?: number | null;
      readonly attemptId?: string;
      readonly error?: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "attempt.started";
      readonly turnId: string;
      readonly attemptId: string;
      readonly reason: SessionWireAttemptReason;
    })
  | (SessionWireFrameBase & {
      readonly type: "attempt.superseded";
      readonly turnId: string;
      readonly attemptId: string;
      readonly supersededByAttemptId: string;
      readonly reason: SessionWireAttemptReason;
    })
  | (SessionWireFrameBase & {
      readonly type: "assistant.delta";
      readonly turnId: string;
      readonly attemptId: string;
      readonly lane: "answer" | "thinking";
      readonly delta: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "tool.started";
      readonly turnId: string;
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly toolName: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "tool.progress" | "tool.finished";
      readonly turnId: string;
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly verdict: string;
      readonly isError: boolean;
      readonly text: string;
      readonly display?: ToolOutputDisplayView;
    })
  | (SessionWireFrameBase & {
      readonly type: "turn.committed";
      readonly turnId: string;
      readonly attemptId: string;
      readonly status: SessionWireCommittedStatus;
      readonly assistantText: string;
      readonly assistantSegments?: readonly AssistantTextSegmentView[];
      readonly toolOutputs: readonly ToolOutputView[];
    })
  | (SessionWireFrameBase & {
      readonly type: "approval.requested";
      readonly turnId: string;
      readonly requestId: string;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly subject: string;
      readonly detail?: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "approval.decided";
      readonly turnId: string;
      readonly requestId: string;
      readonly decision: "approved" | "rejected";
      readonly actor?: string;
      readonly reason?: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "session.closed";
      readonly reason?: string;
    });
export type SessionWireAttemptReason =
  | "initial"
  | "output_budget_escalation"
  | "compaction_retry"
  | "provider_fallback_retry"
  | "max_output_recovery";
export type SessionWireCommittedStatus = "completed" | "failed" | "cancelled";
export type SessionWireTransitionFamily = string;
export type SessionWireTransitionStatus = string;
export type SessionWireTurnTrigger = string;

export function compileSessionWireFrames(
  events: readonly BrewvaEventRecord[],
  ..._rest: unknown[]
): readonly SessionWireFrame[] {
  return events.flatMap((entry) => {
    if (entry.type !== TURN_INPUT_RECORDED_EVENT_TYPE) {
      return [];
    }
    return [
      Object.freeze({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: entry.sessionId,
        frameId: `event:${entry.id}`,
        ts: entry.timestamp,
        source: "replay",
        durability: "durable",
        sourceEventId: entry.id,
        sourceEventType: entry.type,
        type: "turn.input" as const,
        turnId: entry.turnId ?? entry.id,
        promptText: typeof entry.payload === "string" ? entry.payload : "",
        trigger: "recovery" as const,
      }),
    ];
  });
}

export type DelegationRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "merged";
export interface DelegationRunRecord {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly agent: string;
  readonly targetName: string;
  readonly taskName: string;
  readonly taskPath: string;
  readonly depth: number;
  readonly forkTurns: DelegationForkTurns;
  readonly gateReason: string;
  readonly modelCategory: DelegationModelCategory;
  readonly delegate: string;
  readonly status: DelegationRunStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly label?: string;
  readonly nickname?: string;
  readonly kind?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly agentSpec?: string;
  readonly envelope?: string;
  readonly skillName?: string;
  readonly consultKind?: string;
  readonly boundary?: string;
  readonly executionPrimitive?: DelegationExecutionPrimitive;
  readonly visibility?: DelegationVisibility;
  readonly isolationStrategy?: DelegationIsolationStrategy;
  readonly adoption?: DelegationAdoptionDecision;
  readonly lineage?: ProtocolRecord;
  readonly parentSkill?: string;
  readonly artifactRefs?: DelegationArtifactRef[];
  readonly modelRoute?: DelegationModelRouteRecord;
  readonly workerSessionId?: string;
  readonly delivery?: DelegationDeliveryRecord;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly resultData?: ProtocolRecord;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly [key: string]: unknown;
}
export interface DelegationRunQuery extends ProtocolRecord {
  readonly runIds?: readonly string[];
  readonly taskPaths?: readonly string[];
  readonly nicknames?: readonly string[];
  readonly pathPrefix?: string;
  readonly statuses?: readonly DelegationRunStatus[];
  readonly includeTerminal?: boolean;
  readonly limit?: number;
}
export interface DelegationAdoptionRecord extends ProtocolRecord {}
export interface DelegationArtifactRef {
  readonly path: string;
  readonly kind?: string;
  readonly summary?: string;
}
export type DelegationConsultKind = string;
export type DelegationDeliveryHandoffState = string;
export type DelegationDeliveryMode = string;
export interface DelegationDeliveryRecord extends ProtocolRecord {
  readonly mode: string;
  readonly scopeId?: string;
  readonly handoffState?: string;
  readonly label?: string;
  readonly supplementalAppended?: boolean;
  readonly readyAt?: number;
  readonly surfacedAt?: number;
  readonly updatedAt?: number;
}
export type DelegationExecutionPrimitive = string;
export type DelegationForkTurns = number | "none" | "all";
export type DelegationGateReason = string;
export type DelegationIsolationStrategy = string;
export interface DelegationLifecycleEventPayload extends ProtocolRecord {
  readonly contractVersion?: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  readonly runId?: string;
  readonly agent?: string;
  readonly targetName?: string;
  readonly taskName?: string;
  readonly taskPath?: string;
  readonly nickname?: string;
  readonly depth?: number;
  readonly forkTurns?: DelegationForkTurns;
  readonly gateReason?: string;
  readonly modelCategory?: DelegationModelCategory;
  readonly delegate?: string;
  readonly adoption?: DelegationAdoptionRecord;
  readonly lineage?: ProtocolRecord;
  readonly agentSpec?: string;
  readonly envelope?: string;
  readonly skillName?: string;
  readonly status?: DelegationRunStatus;
  readonly label?: string;
  readonly childSessionId?: string;
  readonly parentSkill?: string;
  readonly kind?: string;
  readonly consultKind?: string;
  readonly boundary?: string;
  readonly modelRoute?: DelegationModelRouteRecord;
  readonly summary?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly resultData?: ProtocolRecord;
  readonly artifactRefs?: DelegationArtifactRef[];
  readonly delivery?: DelegationDeliveryRecord;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly executionPrimitive?: DelegationExecutionPrimitive;
  readonly visibility?: DelegationVisibility;
  readonly isolationStrategy?: DelegationIsolationStrategy;
}
export interface DelegationLineageRecord extends ProtocolRecord {}
export type DelegationModelCategory = string;
export type DelegationModelRouteMode = string;
export interface DelegationModelRouteRecord extends ProtocolRecord {
  readonly selectedModel?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly policyId?: string;
  readonly presetName?: string;
  readonly category?: string;
  readonly reason?: string;
  readonly source?: DelegationModelRouteSource;
}
export type DelegationModelRouteSource = string;
export type DelegationOutcomeKind = string;
export type DelegationVisibility = string;
export interface EvidenceSubagentOutcomeData extends ProtocolRecord {}
export interface KnowledgeSubagentOutcomeData extends ProtocolRecord {}
export interface PendingDelegationOutcomeQuery extends ProtocolRecord {
  readonly limit?: number;
}
export type PublicSubagentRole = string;
export interface VerifierCheck extends ProtocolRecord {
  readonly status: string;
  readonly summary?: string;
  readonly name?: string;
}
export interface VerifierCommandCheck extends ProtocolRecord {}
export interface VerifierSubagentOutcomeData {
  readonly kind?: "verifier";
  readonly checks: readonly VerifierCheck[];
  readonly verdict: string;
  readonly missing_evidence?: readonly string[];
  readonly confidence_gaps?: readonly string[];
  readonly environment_limits?: readonly string[];
}
export interface WorkerResultsAppliedEventPayload extends ProtocolRecord {
  readonly workerIds?: string[];
}
export interface DelegationAdoptionDecision extends ProtocolRecord {
  readonly decision?: string;
  readonly contractId?: string;
  readonly reason?: string;
}
export type DelegationAdoptionContractId = string;
export interface DelegationAdoptionInput extends ProtocolRecord {}

export function isDelegationRunTerminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

export function evaluateDelegationAdoption(input: ProtocolRecord): DelegationAdoptionDecision {
  return Object.freeze({ adopt: true, ...input });
}

export type ScheduleContinuityMode = string;
export type ScheduleIntentStatus = string;
export type ScheduleIntentEventKind = string;
export interface ScheduleIntentEventPayload extends ProtocolRecord {
  readonly kind?: ScheduleIntentEventKind;
  readonly intentId?: string;
  readonly error?: string | null;
}
export interface ScheduleIntentProjectionRecord extends ProtocolRecord {
  readonly intentId: string;
  readonly status: ScheduleIntentStatus;
  readonly reason: string;
  readonly parentSessionId: string;
  readonly goalRef?: string;
  readonly continuityMode: ScheduleContinuityMode;
  readonly runAt?: number;
  readonly nextRunAt?: number;
  readonly cron?: string;
  readonly timeZone?: string;
  readonly runCount: number;
  readonly maxRuns: number;
}
export interface ScheduleIntentCreateInput extends ProtocolRecord {
  readonly reason: string;
  readonly intentId?: string;
  readonly goalRef?: string;
  readonly continuityMode?: ScheduleContinuityMode;
  readonly runAt?: number;
  readonly cron?: string;
  readonly timeZone?: string;
  readonly maxRuns?: number;
  readonly convergenceCondition?: unknown;
}
export type ScheduleIntentCreateResult =
  | { readonly ok: true; readonly intent: ScheduleIntentProjectionRecord }
  | { readonly ok: false; readonly reason: string };
export interface ScheduleIntentCancelInput extends ProtocolRecord {
  readonly intentId: string;
  readonly reason?: string;
}
export type ScheduleIntentCancelResult =
  | { readonly ok: true; readonly intent: ScheduleIntentProjectionRecord }
  | { readonly ok: false; readonly reason: string };
export interface ScheduleIntentUpdateInput extends ProtocolRecord {
  readonly intentId: string;
  reason?: string;
  goalRef?: string;
  continuityMode?: ScheduleContinuityMode;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  maxRuns?: number;
  convergenceCondition?: unknown;
}
export type ScheduleIntentUpdateResult =
  | { readonly ok: true; readonly intent: ScheduleIntentProjectionRecord }
  | { readonly ok: false; readonly reason: string };
export interface ScheduleIntentListQuery extends ProtocolRecord {}
export interface ScheduleProjectionSnapshot extends ProtocolRecord {
  readonly watermarkOffset: number;
}
export interface ConvergencePredicate extends ProtocolRecord {}
export interface RecoveryWalIngressWatermarkRecord extends ProtocolRecord {}
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
export interface BuildScheduleIntentCreatedEventInput extends ProtocolRecord {}
export interface NextCronRunOptions {
  readonly from?: Date;
  readonly timeZone?: string;
}
export type ParseCronExpressionResult =
  | { readonly ok: true; readonly expression: string }
  | { readonly ok: false; readonly expression: string; readonly reason: string };
export interface ParsedCronExpression {
  readonly expression: string;
}

export function buildScheduleIntentCreatedEvent(
  input: ProtocolRecord,
  ..._rest: unknown[]
): BrewvaEventRecord {
  return makeEvent(SCHEDULE_EVENT_TYPE, { kind: "created", ...input });
}
export function buildScheduleIntentFiredEvent(
  input: ProtocolRecord,
  ..._rest: unknown[]
): BrewvaEventRecord {
  return makeEvent(SCHEDULE_EVENT_TYPE, { kind: "fired", ...input });
}
export function buildScheduleIntentCancelledEvent(
  input: ProtocolRecord,
  ..._rest: unknown[]
): BrewvaEventRecord {
  return makeEvent(SCHEDULE_EVENT_TYPE, { kind: "cancelled", ...input });
}
export function buildScheduleIntentConvergedEvent(
  input: ProtocolRecord,
  ..._rest: unknown[]
): BrewvaEventRecord {
  return makeEvent(SCHEDULE_EVENT_TYPE, { kind: "converged", ...input });
}
export function buildScheduleIntentUpdatedEvent(
  input: ProtocolRecord,
  ..._rest: unknown[]
): BrewvaEventRecord {
  return makeEvent(SCHEDULE_EVENT_TYPE, { kind: "updated", ...input });
}
export function isScheduleIntentEventPayload(value: unknown): value is ScheduleIntentEventPayload {
  return typeof value === "object" && value !== null;
}
export function parseScheduleIntentEvent(
  record: BrewvaEventRecord,
): ScheduleIntentEventPayload | null {
  return isScheduleIntentEventPayload(record.payload) ? record.payload : null;
}
export function normalizeTimeZone(value: string | undefined): string {
  return value?.trim() || "UTC";
}
export function parseCronExpression(expression: string): ParseCronExpressionResult {
  const normalized = expression.trim();
  const fields = normalized.split(/\s+/u);
  if (fields.length !== 5) {
    return { ok: false, expression: normalized, reason: "cron_field_count" };
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    !/^\d{1,2}$/u.test(minute) ||
    !/^\d{1,2}$/u.test(hour) ||
    dayOfMonth !== "*" ||
    month !== "*" ||
    dayOfWeek !== "*"
  ) {
    return { ok: false, expression: normalized, reason: "unsupported_cron_expression" };
  }
  const parsedMinute = Number.parseInt(minute, 10);
  const parsedHour = Number.parseInt(hour, 10);
  if (parsedMinute < 0 || parsedMinute > 59 || parsedHour < 0 || parsedHour > 23) {
    return { ok: false, expression: normalized, reason: "cron_range" };
  }
  return { ok: true, expression: normalized };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

interface LocalMinuteParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const localMinuteFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getLocalMinuteFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = localMinuteFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  localMinuteFormatterCache.set(timeZone, formatter);
  return formatter;
}

function localTimePartsFor(formatter: Intl.DateTimeFormat, date: Date): LocalMinuteParts {
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year") ?? "0"),
    month: Number(values.get("month") ?? "0"),
    day: Number(values.get("day") ?? "0"),
    hour: Number(values.get("hour") ?? "0"),
    minute: Number(values.get("minute") ?? "0"),
  };
}

function addCalendarDays(
  parts: Pick<LocalMinuteParts, "year" | "month" | "day">,
  days: number,
): Pick<LocalMinuteParts, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localMinuteMatches(actual: LocalMinuteParts, expected: LocalMinuteParts): boolean {
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute
  );
}

function timeZoneOffsetMs(formatter: Intl.DateTimeFormat, date: Date): number {
  const local = localTimePartsFor(formatter, date);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return localAsUtc - (date.getTime() - (date.getTime() % MINUTE_MS));
}

function localMinuteInstants(formatter: Intl.DateTimeFormat, local: LocalMinuteParts): number[] {
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set<number>();
  for (const sampleHour of [-36, -24, -12, 0, 12, 24, 36]) {
    offsets.add(timeZoneOffsetMs(formatter, new Date(localAsUtc + sampleHour * HOUR_MS)));
  }

  const seen = new Set<number>();
  const instants: number[] = [];
  for (const offset of offsets) {
    const instant = localAsUtc - offset;
    if (seen.has(instant)) {
      continue;
    }
    if (localMinuteMatches(localTimePartsFor(formatter, new Date(instant)), local)) {
      seen.add(instant);
      instants.push(instant);
    }
  }
  return instants.toSorted((left, right) => left - right);
}

export function getNextCronRunAt(
  expression: string,
  optionsOrAfterMs: NextCronRunOptions | number = {},
  maybeOptions: Omit<NextCronRunOptions, "from"> = {},
): Date {
  const options =
    typeof optionsOrAfterMs === "number"
      ? { ...maybeOptions, from: new Date(optionsOrAfterMs) }
      : optionsOrAfterMs;
  const from = options.from instanceof Date ? options.from : new Date();
  const parsed = parseCronExpression(expression);
  if (!parsed.ok) {
    return new Date(from.getTime() + 60_000);
  }
  const [minuteRaw, hourRaw] = parsed.expression.split(/\s+/u);
  const targetMinute = Number.parseInt(minuteRaw ?? "0", 10);
  const targetHour = Number.parseInt(hourRaw ?? "0", 10);
  const timeZone = normalizeTimeZone(options.timeZone);
  const formatter = getLocalMinuteFormatter(timeZone);
  const start = from.getTime() + MINUTE_MS - (from.getTime() % MINUTE_MS);
  const startLocal = localTimePartsFor(formatter, new Date(start));

  for (let dayOffset = 0; dayOffset <= 366; dayOffset += 1) {
    const localDate = addCalendarDays(startLocal, dayOffset);
    const localTarget = {
      ...localDate,
      hour: targetHour,
      minute: targetMinute,
    };
    for (const instant of localMinuteInstants(formatter, localTarget)) {
      if (instant >= start) {
        return new Date(instant);
      }
    }
  }
  return new Date(start);
}

export type TaskItemStatus = string;
export type TaskPhase = string;
export interface TaskSpec extends ProtocolRecord {
  readonly goal?: string;
  readonly description?: string;
  readonly expectedBehavior?: string;
  readonly constraints?: readonly string[];
}
export interface TaskSpecSchema extends ProtocolRecord {}
export interface TaskState {
  readonly blockers: Array<{
    readonly id?: string;
    readonly message?: string;
    readonly [key: string]: unknown;
  }>;
  readonly spec?: TaskSpec | null;
  readonly status?: TaskStatus;
  readonly acceptance?: TaskAcceptanceState;
  readonly items: unknown[];
  readonly updatedAt?: number | null;
  readonly [key: string]: unknown;
}
export interface HydratedTaskState extends ProtocolRecord {}
export type TaskAcceptanceRecordResult =
  | { readonly ok: true; readonly status: TaskAcceptanceState["status"] }
  | { readonly ok: false; readonly reason: string };
export interface TaskAcceptanceState extends ProtocolRecord {
  readonly status?: "pending" | "accepted" | "rejected";
}
export type TaskAcceptanceStatus = string;
export interface TaskBlocker extends ProtocolRecord {
  readonly id?: string;
  readonly message?: string;
}
export type TaskBlockerRecordResult =
  | { readonly ok: true; readonly blockerId: string }
  | { readonly ok: false; readonly reason: string };
export type TaskBlockerResolveResult =
  | { readonly ok: true; readonly blockerId?: string }
  | { readonly ok: false; readonly reason: string };
export interface TaskHealth extends ProtocolRecord {}
export interface TaskItem extends ProtocolRecord {
  readonly id: string;
  readonly text: string;
  readonly status?: TaskItemStatus;
}
export type TaskItemAddResult =
  | { readonly ok: true; readonly itemId: string; readonly item: TaskItem }
  | { readonly ok: false; readonly reason: string };
export type TaskItemUpdateResult =
  | { readonly ok: true; readonly itemId: string; readonly item: TaskItem }
  | { readonly ok: false; readonly reason: string };
export interface TaskLedgerEventPayload extends ProtocolRecord {}
export interface TaskStatus extends ProtocolRecord {
  readonly phase?: string;
  readonly health?: string;
}
export interface TaskTargetDescriptor extends ProtocolRecord {}
export type TaskAgentItemStatus = string;
export interface TaskStallAdjudicatedPayload extends ProtocolRecord {
  readonly detectedAt: number;
  readonly baselineProgressAt: number;
  readonly adjudicatedAt?: number;
  readonly decision: "accepted" | "rejected" | "pending";
  readonly source: string;
  readonly rationale?: string | null;
  readonly signalSummary: string[];
  readonly verificationLastOutcome?: "pass" | "fail" | "skipped" | null;
}
export type TaskStallAdjudicationDecision = string;
export interface TaskStuckClearedPayload extends ProtocolRecord {}
export interface TaskStuckDetectedPayload extends ProtocolRecord {
  readonly detectedAt: number;
  readonly baselineProgressAt: number;
  readonly thresholdMs: number;
  readonly idleMs: number;
  readonly openItemCount: number;
  readonly reason?: string | null;
}
export interface TaskWatchdogEligibility extends ProtocolRecord {}

export function createEmptyTaskState(): TaskState {
  return { items: [], blockers: [], status: { phase: "pending" } };
}
export function isHydratedTaskState(value: unknown): value is HydratedTaskState {
  return typeof value === "object" && value !== null;
}
export function normalizeTaskSpec(value: unknown): TaskSpec {
  return typeof value === "object" && value !== null
    ? (value as ProtocolRecord)
    : {
        description: typeof value === "string" ? value : value == null ? "" : JSON.stringify(value),
      };
}
export type TaskSpecParseResult =
  | { readonly ok: true; readonly spec: TaskSpec }
  | { readonly ok: false; readonly reason: string };
export function parseTaskSpec(value: unknown): TaskSpecParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "TaskSpec must be an object" };
  }
  return { ok: true, spec: normalizeTaskSpec(value) };
}
export function buildItemAddedEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(TASK_EVENT_TYPE, { schema: TASK_LEDGER_SCHEMA, kind: "item.added", ...input });
}
export function buildItemUpdatedEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(TASK_EVENT_TYPE, { schema: TASK_LEDGER_SCHEMA, kind: "item.updated", ...input });
}
export function buildSpecSetEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(TASK_EVENT_TYPE, { schema: TASK_LEDGER_SCHEMA, kind: "spec.set", ...input });
}
export function buildStatusSetEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(TASK_EVENT_TYPE, { schema: TASK_LEDGER_SCHEMA, kind: "status.set", ...input });
}
export function buildBlockerRecordedEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(TASK_EVENT_TYPE, {
    schema: TASK_LEDGER_SCHEMA,
    kind: "blocker.recorded",
    ...input,
  });
}
export function buildBlockerResolvedEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(TASK_EVENT_TYPE, {
    schema: TASK_LEDGER_SCHEMA,
    kind: "blocker.resolved",
    ...input,
  });
}
export function buildCheckpointSetEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(TASK_EVENT_TYPE, {
    schema: TASK_LEDGER_SCHEMA,
    kind: "checkpoint.set",
    ...input,
  });
}
export function buildAcceptanceSetEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(TASK_EVENT_TYPE, {
    schema: TASK_LEDGER_SCHEMA,
    kind: "acceptance.set",
    ...input,
  });
}
export function coerceTaskLedgerPayload(value: unknown): TaskLedgerEventPayload | null {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : null;
}
export function isTaskLedgerPayload(value: unknown): value is TaskLedgerEventPayload {
  return coerceTaskLedgerPayload(value) !== null;
}
export function reduceTaskState(state: TaskState, payload: TaskLedgerEventPayload): TaskState {
  return { ...state, lastEvent: payload };
}
export function foldTaskLedgerEvents(events: readonly BrewvaEventRecord[]): TaskState {
  return events.reduce(
    (state, entry) => reduceTaskState(state, payloadOf(entry)),
    createEmptyTaskState(),
  );
}
export function formatTaskStateBlock(state: TaskState): string {
  return JSON.stringify(state, null, 2);
}
export function formatTaskItemStatusForSurface(status: string): string {
  return status;
}
export function formatTaskVerificationLevelForSurface(level: unknown): string {
  return typeof level === "string" && level.trim().length > 0 ? level : "none";
}
export const TASK_STALL_ADJUDICATION_SCHEMA = "brewva.task.stall-adjudication.v1" as const;
export const TASK_WATCHDOG_SCHEMA = "brewva.task.watchdog.v1" as const;
export function buildTaskStallAdjudicatedPayload(
  input: ProtocolRecord,
): TaskStallAdjudicatedPayload {
  return {
    schema: TASK_STALL_ADJUDICATION_SCHEMA,
    ...input,
  } as unknown as TaskStallAdjudicatedPayload;
}
export function buildTaskStuckDetectedPayload(input: ProtocolRecord): TaskStuckDetectedPayload {
  return { schema: TASK_WATCHDOG_SCHEMA, ...input } as unknown as TaskStuckDetectedPayload;
}
export function buildTaskStuckClearedPayload(input: ProtocolRecord): TaskStuckClearedPayload {
  return { schema: TASK_WATCHDOG_SCHEMA, cleared: true, ...input };
}
export function coerceTaskStallAdjudicatedPayload(
  value: unknown,
): TaskStallAdjudicatedPayload | null {
  return typeof value === "object" && value !== null
    ? (value as TaskStallAdjudicatedPayload)
    : null;
}
export function coerceTaskStuckDetectedPayload(value: unknown): TaskStuckDetectedPayload | null {
  return typeof value === "object" && value !== null ? (value as TaskStuckDetectedPayload) : null;
}
export function computeTaskSemanticProgressAt(input: ProtocolRecord): ProtocolRecord {
  return { progressed: false, ...input };
}
export function evaluateTaskWatchdogEligibility(input: ProtocolRecord): TaskWatchdogEligibility {
  return { eligible: true, ...input };
}
export function getTaskWatchdogOpenItemCount(state: TaskState): number {
  return Array.isArray(state.items) ? state.items.length : 0;
}
export function isTaskWatchdogEventType(type: string): boolean {
  return type.startsWith("task.");
}
export function toTaskWatchdogEventPayload(input: ProtocolRecord): ProtocolRecord {
  return input;
}

export interface ClaimLedgerEventPayload extends ProtocolRecord {}
export interface ClaimResolveResult extends ProtocolRecord {
  readonly ok?: boolean;
}
export type ClaimSeverity = string;
export interface ClaimState extends ProtocolRecord {
  readonly claims: readonly OperationalClaim[];
  readonly updatedAt?: number | null;
}
export type ClaimStatus = string;
export interface ClaimUpsertResult extends ProtocolRecord {
  readonly ok?: boolean;
}
export interface OperationalClaim extends ProtocolRecord {}
export function createEmptyClaimState(): ClaimState {
  return { claims: [] };
}
export function buildClaimUpsertedEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(CLAIM_EVENT_TYPE, {
    schema: CLAIM_LEDGER_SCHEMA,
    kind: "claim.upserted",
    ...input,
  });
}
export function buildClaimResolvedEvent(input: ProtocolRecord): BrewvaEventRecord {
  return makeEvent(CLAIM_EVENT_TYPE, {
    schema: CLAIM_LEDGER_SCHEMA,
    kind: "claim.resolved",
    ...input,
  });
}
export function coerceClaimLedgerPayload(value: unknown): ClaimLedgerEventPayload | null {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : null;
}
export function isClaimLedgerPayload(value: unknown): value is ClaimLedgerEventPayload {
  return coerceClaimLedgerPayload(value) !== null;
}
export function reduceClaimState(state: ClaimState, payload: ClaimLedgerEventPayload): ClaimState {
  return { ...state, lastEvent: payload };
}
export function foldClaimLedgerEvents(events: readonly BrewvaEventRecord[]): ClaimState {
  return events.reduce(
    (state, entry) => reduceClaimState(state, payloadOf(entry)),
    createEmptyClaimState(),
  );
}

export type SkillCategory = string;
export type LoadableSkillCategory = string;
export interface SkillDocument extends ProtocolRecord {
  readonly name: string;
  readonly title?: string;
  readonly baseDir: string;
  readonly category: string;
  readonly filePath: string;
  readonly description: string;
  readonly markdown: string;
  readonly card: SkillCard;
  readonly resources: SkillResourceSet;
}
export type ParsedSkillDocument = SkillDocument;
export type OverlaySkillDocument = SkillDocument;
export interface SkillCard extends ProtocolRecord {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly selection?: SkillSelectionPolicy;
}
export type SkillCardLike = SkillCard;
export type SkillCardOverride = Partial<SkillCard> & ProtocolRecord;
export type SkillIndexOrigin = string;
export type SkillOutputContract =
  | ({
      readonly kind: "text";
      readonly minWords?: number;
      readonly minLength?: number;
    } & ProtocolRecord)
  | ({
      readonly kind: "json";
      readonly minItems?: number;
      readonly minKeys?: number;
    } & ProtocolRecord)
  | ({ readonly kind: "enum"; readonly values: readonly string[] } & ProtocolRecord);
export interface SkillOutputEnumContract extends ProtocolRecord {}
export interface SkillOutputJsonContract extends ProtocolRecord {}
export interface SkillOutputTextContract extends ProtocolRecord {}
export type SkillOverlayCard = SkillCard;
export type SkillOverlayCategory = string;
export interface SkillRefreshInput extends ProtocolRecord {}
export interface SkillRefreshResult extends ProtocolRecord {}
export interface SkillRegistryLoadReport extends ProtocolRecord {
  readonly loadedSkills: readonly string[];
  readonly selectableSkills: readonly string[];
  readonly overlaySkills: readonly string[];
  readonly roots: readonly string[];
  readonly projectGuidance: readonly ProjectGuidanceEntry[];
}
export interface SkillRegistryRoot extends ProtocolRecord {
  readonly id?: string;
  readonly path?: string;
  readonly source?: SkillRootSource;
}
export interface SkillResourceSet extends ProtocolRecord {
  readonly references: readonly string[];
  readonly scripts: readonly string[];
  readonly invariants: readonly string[];
}
export type SkillRootSource = string;
export interface SkillSelectionPolicy extends ProtocolRecord {
  readonly whenToUse?: string;
  readonly triggers?: readonly string[];
  readonly pathGlobs?: readonly string[];
}
export type SkillSemanticBindings = Record<string, string>;
export interface SkillSystemInstallResult extends ProtocolRecord {}
export interface SkillsIndexEntry extends ProtocolRecord {
  readonly name: string;
  readonly card: SkillCard;
  readonly resources: SkillResourceSet;
}
export interface SkillsIndexFile extends ProtocolRecord {
  readonly skills?: readonly SkillsIndexEntry[];
}
export interface ProducerContract extends ProtocolRecord {
  readonly source?: string;
  readonly producer?: string;
  readonly filePath?: string;
  readonly outputs?: readonly string[];
  readonly outputContracts?: Record<string, SkillOutputContract>;
  readonly semanticBindings?: Record<string, string>;
}
export interface ProjectGuidanceEntry extends ProtocolRecord {}
export type ProjectGuidanceStrength = string;
export type SemanticArtifactSchemaId = string;
export type SkillArtifactIssueTier = string;
export interface SkillNormalizedBlockingState extends ProtocolRecord {}
export interface SkillNormalizedOutputIssue extends ProtocolRecord {}
export interface SkillNormalizedOutputsView extends ProtocolRecord {}
export type PlanningOwnerLane = string;
export type ReviewChangeCategory = string;
export type ReviewLaneName = string;
export type ReviewPrecedentConsultDisposition = string;
export type ReviewPrecedentConsultStatus = string;
export interface ReviewReportArtifact extends ProtocolRecord {}
export type ReviewReportRequiredField = string;
export type DesignExecutionModeHint = string;
export interface DesignExecutionStep extends ProtocolRecord {}
export interface DesignImplementationTarget extends ProtocolRecord {}
export interface DesignRiskItem extends ProtocolRecord {}
export type DesignRiskSeverity = string;
export interface PlanningArtifactSet extends ProtocolRecord {}
export type PlanningEvidenceKey = string;
export interface PlanningEvidenceState extends ProtocolRecord {}

function readDocumentSource(sourceOrPath: string): {
  readonly source: string;
  readonly baseDir: string;
} {
  if (existsSync(sourceOrPath)) {
    return { source: readFileSync(sourceOrPath, "utf8"), baseDir: dirname(sourceOrPath) };
  }
  return { source: sourceOrPath, baseDir: process.cwd() };
}

function readYamlFrontmatter(source: string): {
  readonly frontmatter: ProtocolRecord;
  readonly markdown: string;
} {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/u.exec(source);
  if (!match) {
    return { frontmatter: {}, markdown: source };
  }
  const parsed = parseYaml(match[1] ?? "");
  return {
    frontmatter: typeof parsed === "object" && parsed !== null ? (parsed as ProtocolRecord) : {},
    markdown: source.slice(match[0].length),
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function readSkillSelection(value: unknown): SkillSelectionPolicy | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as ProtocolRecord;
  const selection: {
    whenToUse?: string;
    triggers?: string[];
    pathGlobs?: string[];
  } = {};
  if (typeof record.when_to_use === "string") {
    selection.whenToUse = record.when_to_use;
  }
  const triggers = readStringArray(record.triggers);
  if (triggers.length > 0) {
    selection.triggers = triggers;
  }
  const pathGlobs = readStringArray(record.path_globs);
  if (pathGlobs.length > 0) {
    selection.pathGlobs = pathGlobs;
  }
  return Object.keys(selection).length > 0 ? selection : undefined;
}

export function parseSkillDocument(
  sourceOrPath: string,
  category: SkillCategory = "core",
): ParsedSkillDocument {
  const { source, baseDir } = readDocumentSource(sourceOrPath);
  const { frontmatter, markdown } = readYamlFrontmatter(source);
  if ("intent" in frontmatter) {
    throw new Error("SkillCard field 'intent' has been removed");
  }
  const title =
    markdown
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.replace(/^#\s*/u, "") ?? "Skill";
  const name = typeof frontmatter.name === "string" ? frontmatter.name : title;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : `${title}.`;
  const selection = readSkillSelection(frontmatter.selection);
  const card: SkillCard = selection
    ? { name, category, description, selection }
    : { name, category, description };
  return {
    name,
    title,
    source,
    baseDir,
    filePath: existsSync(sourceOrPath) ? sourceOrPath : "",
    category,
    markdown,
    description,
    card,
    resources: {
      references: readStringArray(frontmatter.references),
      scripts: readStringArray(frontmatter.scripts),
      invariants: readStringArray(frontmatter.invariants),
    },
  };
}
export function createEmptySkillResources(): SkillResourceSet {
  return { references: [], scripts: [], invariants: [] };
}
export function discoverSkillRegistryRoots(): readonly SkillRegistryRoot[] {
  return [];
}
export function ensureBundledSystemSkills(): SkillSystemInstallResult {
  return { installed: [] };
}
export class SkillRegistry {
  readonly skills = new Map<string, SkillDocument>();
  list(): readonly SkillDocument[] {
    return [...this.skills.values()];
  }
}
export function mergeOverlayCard(base: ProtocolRecord, override: ProtocolRecord): ProtocolRecord {
  return { ...base, ...override };
}
export function mergeSkillResources(left: ProtocolRecord, right: ProtocolRecord): ProtocolRecord {
  return { ...left, ...right };
}
export function parseProducerContractFile(
  sourceOrPath: string,
  ..._rest: unknown[]
): ProducerContract {
  const { source } = readDocumentSource(sourceOrPath);
  const parsed = parseYaml(source);
  const record = typeof parsed === "object" && parsed !== null ? (parsed as ProtocolRecord) : {};
  const rawContracts =
    typeof record.output_contracts === "object" && record.output_contracts !== null
      ? (record.output_contracts as ProtocolRecord)
      : {};
  const outputContractEntries: Array<[string, SkillOutputContract]> = Object.entries(
    rawContracts,
  ).flatMap(([key, value]) => {
    if (typeof value !== "object" || value === null) return [];
    const contract = value as ProtocolRecord;
    const normalized = Object.fromEntries(
      Object.entries(contract).filter(([contractKey]) => contractKey !== "min_words"),
    );
    return [
      [
        key,
        {
          ...normalized,
          ...(typeof contract.min_words === "number" ? { minWords: contract.min_words } : {}),
        },
      ] as [string, SkillOutputContract],
    ];
  });
  const outputContracts: Record<string, SkillOutputContract> =
    Object.fromEntries(outputContractEntries);
  return {
    source,
    producer: optionalStringField(record, "producer") ?? source,
    filePath: sourceOrPath,
    outputs: readStringArray(record.outputs),
    outputContracts,
  };
}
export function getProducerOutputContracts(
  producer: ProducerContract | undefined,
): Record<string, SkillOutputContract> {
  return producer?.outputContracts ?? {};
}
export function getProducerSemanticBindings(
  producer: ProducerContract | undefined,
): SkillSemanticBindings {
  return producer?.semanticBindings ?? {};
}
export function getSemanticArtifactOutputContract(id: string): SkillOutputContract {
  return { id, kind: "enum", values: [] };
}
export function isSemanticArtifactSchemaId(value: string): boolean {
  return value.trim().length > 0;
}
export function listProducerOutputs(producer: ProducerContract | undefined): readonly string[] {
  return producer?.outputs ?? [];
}
export function normalizeSemanticArtifactSchemaId(value: string): string {
  return value.trim().toLowerCase();
}
export function renderSemanticArtifactExample(input: ProtocolRecord): string {
  return JSON.stringify(input, null, 2);
}
export function coercePlanningArtifactSet(value: unknown): PlanningArtifactSet {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : {};
}
export function coerceReviewReportArtifact(value: unknown): ReviewReportArtifact {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : {};
}
export function collectPlanningRiskCategories(input: ProtocolRecord): readonly string[] {
  return readStringArray(input.risks);
}
export function isPlanningOwnerLane(value: string): boolean {
  return PLANNING_OWNER_LANES.includes(value as never);
}
export function isReviewChangeCategory(value: string): boolean {
  return REVIEW_CHANGE_CATEGORIES.includes(value as never);
}
export function isReviewLaneName(value: string): boolean {
  return REVIEW_LANE_NAMES.includes(value as never);
}
export function normalizeReviewLaneName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "general";
}
export const REVIEW_REPORT_REQUIRED_FIELDS = ["findings", "summary"] as const;
export const DESIGN_EXECUTION_MODE_HINTS: readonly string[] = [];
export const PLANNING_EVIDENCE_KEYS: readonly string[] = [];

export type WorkflowAcceptanceStatus = string;
export interface WorkflowArtifact extends ProtocolRecord {
  readonly type?: string;
  readonly kind: string;
  readonly state: string;
  readonly freshness: string;
  readonly producedAt: number;
  readonly summary: string;
  readonly payload?: JsonValue;
  readonly metadata?: ProtocolRecord;
}
export type WorkflowArtifactFreshness = string;
export type WorkflowArtifactKind = string;
export interface WorkflowArtifactState extends ProtocolRecord {}
export type WorkflowFinishState = string;
export interface WorkflowFinishView extends ProtocolRecord {
  readonly state: string;
  readonly summary: string;
  readonly completed: boolean;
  readonly verified: boolean;
  readonly acceptance: string;
  readonly ship: string;
  readonly deliverable: string;
  readonly missingEvidence: readonly string[];
  readonly blockers: readonly string[];
}
export type WorkflowImplementationStatus = string;
export type WorkflowLaneStatus = string;
export type WorkflowPlanningStatus = string;
export type WorkflowPosture = string;
export type WorkflowPresenceStatus = string;
export interface WorkflowPostureSnapshot extends ProtocolRecord {
  readonly discovery: WorkflowLaneStatus;
  readonly strategy: WorkflowLaneStatus;
  readonly planning: WorkflowLaneStatus;
  readonly plan_complete: WorkflowLaneStatus;
  readonly plan_fresh: WorkflowLaneStatus;
  readonly implementation: WorkflowLaneStatus;
  readonly review_required: WorkflowLaneStatus;
  readonly review: WorkflowLaneStatus;
  readonly verifier: WorkflowLaneStatus;
  readonly verification: WorkflowLaneStatus;
  readonly acceptance: WorkflowLaneStatus;
  readonly ship: WorkflowLaneStatus;
  readonly verifier_required?: WorkflowLaneStatus;
  readonly retro?: WorkflowLaneStatus;
  readonly unsatisfied_required_evidence: readonly string[];
  readonly blockers: readonly string[];
}
export interface WorkflowStatusSnapshot extends ProtocolRecord {
  readonly goal?: string;
  readonly phase?: string;
  readonly health?: string;
  readonly updatedAt: number;
  readonly currentWorkspaceRevision?: string | null;
  readonly posture: WorkflowPostureSnapshot;
  readonly artifacts: readonly WorkflowArtifact[];
  readonly finish: WorkflowFinishView;
  readonly pendingWorkerResults?: number;
  readonly pendingDelegationOutcomes?: number;
}
export function deriveWorkflowArtifacts(events: unknown): readonly WorkflowArtifact[] {
  const records = Array.isArray(events)
    ? events
    : typeof events === "object" &&
        events !== null &&
        Array.isArray((events as ProtocolRecord).events)
      ? ((events as ProtocolRecord).events as readonly unknown[])
      : [];
  return records.map((entry) => {
    const record = typeof entry === "object" && entry !== null ? (entry as ProtocolRecord) : {};
    return {
      type: optionalStringField(record, "type"),
      kind: optionalStringField(record, "kind") ?? optionalStringField(record, "type") ?? "event",
      state: optionalStringField(record, "state") ?? "observed",
      freshness: optionalStringField(record, "freshness") ?? "unknown",
      producedAt: numberField(record, "producedAt", numberField(record, "timestamp", 0)),
      summary: optionalStringField(record, "summary") ?? "",
      payload: record.payload as JsonValue | undefined,
    };
  });
}
export function deriveWorkflowArtifactsFromEvent(
  entry: BrewvaEventRecord,
): readonly WorkflowArtifact[] {
  return [
    {
      type: entry.type,
      kind: entry.type,
      state: "observed",
      freshness: "unknown",
      producedAt: entry.timestamp,
      summary: "",
      payload: entry.payload as JsonValue | undefined,
    },
  ];
}
export function deriveWorkflowStatus(events: unknown): WorkflowStatusSnapshot {
  const records = Array.isArray(events)
    ? events
    : typeof events === "object" &&
        events !== null &&
        Array.isArray((events as ProtocolRecord).events)
      ? ((events as ProtocolRecord).events as readonly unknown[])
      : [];
  return {
    eventCount: records.length,
    updatedAt: Date.now(),
    currentWorkspaceRevision: null,
    posture: {
      discovery: "unknown",
      strategy: "unknown",
      planning: "unknown",
      plan_complete: "unknown",
      plan_fresh: "unknown",
      implementation: "unknown",
      review_required: "unknown",
      review: "unknown",
      verifier: "unknown",
      verification: "unknown",
      acceptance: "unknown",
      ship: "unknown",
      verifier_required: "unknown",
      retro: "unknown",
      unsatisfied_required_evidence: [],
      blockers: [],
    },
    artifacts: deriveWorkflowArtifacts(records),
    finish: {
      state: "unknown",
      summary: "",
      completed: false,
      verified: false,
      acceptance: "unknown",
      ship: "unknown",
      deliverable: "unknown",
      missingEvidence: [],
      blockers: [],
    },
  };
}
export function resolveWorkspaceRevision(input: string): string;
export function resolveWorkspaceRevision(input: ProtocolRecord): ProtocolRecord;
export function resolveWorkspaceRevision(input: string | ProtocolRecord): string | ProtocolRecord {
  const workspaceRoot = typeof input === "string" ? input : input.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    return typeof input === "string" ? "unknown" : { revision: "unknown", ...input };
  }
  const headPath = join(workspaceRoot, ".git", "HEAD");
  let revision = "unknown";
  if (existsSync(headPath)) {
    const head = readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref:")) {
      const refPath = join(workspaceRoot, ".git", head.slice("ref:".length).trim());
      revision = existsSync(refPath) ? readFileSync(refPath, "utf8").trim() : "unknown";
    } else if (head.length > 0) {
      revision = head;
    }
  }
  return typeof input === "string" ? revision : { revision, ...input };
}

export interface DeriveTurnEffectCommitmentProjectionInput extends ProtocolRecord {
  readonly runtimeTurn?: number;
  readonly turnId?: string;
  readonly declared?: readonly EffectCommitmentSummary[];
  readonly attempted?: readonly EffectCommitmentAttempt[];
  readonly decisions?: readonly EffectAuthorityDecisionSummary[];
  readonly executed?: readonly EffectExecutionSummary[];
  readonly recovery?: readonly EffectRecoverySummary[];
  readonly warnings?: readonly ProtocolRecord[];
}
export interface EffectAuthorityDecisionSummary extends ProtocolRecord {}
export interface EffectCommitmentAttempt extends ProtocolRecord {}
export interface EffectCommitmentSummary extends ProtocolRecord {}
export interface EffectExecutionSummary extends ProtocolRecord {}
export interface EffectRecoverySummary extends ProtocolRecord {}
export interface RenderTurnConsequenceDigestOptions extends ProtocolRecord {
  readonly runtimeTurn?: number;
  readonly turnId?: string;
  readonly maxChars?: number;
}
export interface TurnEffectCommitmentProjection extends ProtocolRecord {
  readonly runtimeTurn: number;
  readonly turnId?: string;
  readonly declared: readonly EffectCommitmentSummary[];
  readonly attempted: readonly EffectCommitmentAttempt[];
  readonly decisions: readonly EffectAuthorityDecisionSummary[];
  readonly executed: readonly EffectExecutionSummary[];
  readonly recovery: readonly EffectRecoverySummary[];
  readonly warnings: readonly ProtocolRecord[];
}
export function deriveTurnEffectCommitmentProjection(
  input: DeriveTurnEffectCommitmentProjectionInput,
): TurnEffectCommitmentProjection {
  return {
    runtimeTurn: typeof input.runtimeTurn === "number" ? input.runtimeTurn : 0,
    ...(typeof input.turnId === "string" ? { turnId: input.turnId } : {}),
    declared: input.declared ?? [],
    attempted: input.attempted ?? [],
    decisions: input.decisions ?? [],
    executed: input.executed ?? [],
    recovery: input.recovery ?? [],
    warnings: input.warnings ?? [],
  };
}
export function renderTurnConsequenceDigest(
  input: RenderTurnConsequenceDigestOptions & Partial<TurnEffectCommitmentProjection>,
): string {
  const projection = deriveTurnEffectCommitmentProjection(input);
  const digest = `runtimeTurn=${projection.runtimeTurn} declared=${projection.declared.length} attempted=${projection.attempted.length} decisions=${projection.decisions.length} executed=${projection.executed.length} recovery=${projection.recovery.length} warnings=${projection.warnings.length}`;
  const maxChars = typeof input.maxChars === "number" ? Math.max(0, Math.trunc(input.maxChars)) : 0;
  return maxChars > 0 && digest.length > maxChars ? digest.slice(0, maxChars) : digest;
}
export function deriveParallelBudgetStateFromEvents(
  events: readonly BrewvaEventRecord[],
): DerivedParallelBudgetState {
  return {
    eventCount: events.length,
    activeRunIds: [],
    activeCount: 0,
    maxConcurrent: null,
    totalStarted: 0,
  };
}
export interface DerivedParallelBudgetState extends ProtocolRecord {
  readonly eventCount: number;
  readonly activeRunIds: readonly string[];
  readonly activeCount: number;
  readonly maxConcurrent: number | null;
  readonly totalStarted: number;
  readonly latestEventId?: string;
}

export function normalizeEvidenceRef(value: ProtocolRecord): EvidenceRef {
  return value;
}
export function normalizeEvidenceRefs(values: readonly ProtocolRecord[]): Set<string> {
  return new Set(
    values.flatMap((value) => {
      const ref = normalizeEvidenceRef(value);
      const candidates = [ref.id, ref.uri, ref.path, ref.label].filter(
        (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
      );
      return candidates;
    }),
  );
}
export function isEvidenceSourceType(value: string): boolean {
  return value.trim().length > 0;
}
export function computeEvidenceDiversity(input: ProtocolRecord): EvidenceDiversitySummary {
  return { clusters: [], ...input };
}
export function classifyToolFailure(input: unknown): string {
  if (typeof input === "string") return input;
  return "unknown";
}
export function extractEvidenceArtifacts(input: ProtocolRecord): readonly EvidenceArtifact[] {
  return recordArrayField(input, "artifacts");
}
export function coerceTscDiagnosticSeverity(value: string): TscDiagnosticSeverity {
  return value;
}
export function parseTscDiagnostics(
  output: string,
  ..._rest: unknown[]
): {
  readonly diagnostics: TscDiagnostic[];
  readonly truncated: boolean;
  readonly countsByCode?: Record<string, number>;
} {
  const diagnostics = output
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((message) => ({ file: "", message, code: "unknown" }));
  return { diagnostics, truncated: false };
}
export function recordAssistantUsageFromMessage(
  recorder: { readonly recordAssistantUsage?: (usage: ProtocolRecord) => unknown },
  sessionIdOrMessage?: unknown,
  message?: unknown,
): ProtocolRecord {
  const resolvedMessage = typeof sessionIdOrMessage === "string" ? message : sessionIdOrMessage;
  const messageRecord = isProtocolRecord(resolvedMessage) ? resolvedMessage : {};
  const usage =
    messageRecord.usage &&
    typeof messageRecord.usage === "object" &&
    !Array.isArray(messageRecord.usage)
      ? (messageRecord.usage as ProtocolRecord)
      : {};
  recorder.recordAssistantUsage?.(usage);
  return usage;
}
export type AssistantUsageRecorder = (message: ProtocolRecord) => ProtocolRecord;

export const readCapabilityStateRecordedEventPayload = payloadOf;
export const readContextEntryRecordedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): ContextEntryRecord | null => (event.payload ? (event.payload as ContextEntryRecord) : null);
export const readDelegationLifecycleEventPayload = (event: {
  readonly payload?: ProtocolRecord;
  readonly type?: string;
}): DelegationLifecycleEventPayload | null =>
  event.payload ? (event.payload as DelegationLifecycleEventPayload) : null;
export const readEffectCommitmentApprovalRequestedEventPayload = payloadOf;
export const readEffectCommitmentApprovalResolutionEventPayload = payloadOf;
export const readEffectCommitmentDecisionReceiptRecordedEventPayload = payloadOf;
export const readReasoningRevertEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): ReasoningRevertPayload | null =>
  event.payload ? (event.payload as ReasoningRevertPayload) : null;
export const readSessionLineageNodeCreatedEventPayload = payloadOf;
export const readSessionLineageOutcomeAdoptedEventPayload = payloadOf;
export const readSessionLineageOutcomeRecordedEventPayload = payloadOf;
export const readSessionLineageSelectionRecordedEventPayload = payloadOf;
export const readSessionLineageSummaryRecordedEventPayload = payloadOf;
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
export const readSessionTitleRecordedEventPayload = payloadOf;
export const readSessionUncleanShutdownDiagnosticEventPayload = payloadOf;
export const readTaskStallAdjudicatedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): TaskStallAdjudicatedPayload | null =>
  event.payload ? (event.payload as TaskStallAdjudicatedPayload) : null;
export const readTaskStuckDetectedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): TaskStuckDetectedPayload | null =>
  event.payload ? (event.payload as TaskStuckDetectedPayload) : null;
export const readToolCallBlockedEventPayload = payloadOf;
export const readToolLifecycleEventPayload = payloadOf;
export interface ToolOutputDistilledEventPayload extends ProtocolRecord {
  readonly outputText?: string;
  readonly args?: ProtocolRecord;
}
export const readToolOutputDistilledEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): ToolOutputDistilledEventPayload => payloadOf(event) as ToolOutputDistilledEventPayload;
export const readToolResultRecordedEventPayload = (event: {
  readonly type?: string;
  readonly payload?: ProtocolRecord;
}): ToolResultRecordedEventPayload => payloadOf(event) as ToolResultRecordedEventPayload;
export const readTurnInputRecordedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): TurnInputRecordedPayload | null =>
  event.payload ? (event.payload as TurnInputRecordedPayload) : null;
export const readTurnRenderCommittedEventPayload = payloadOf;
export interface VerificationOutcomeRecordedEventPayload extends ProtocolRecord {
  readonly outcome: "pass" | "fail" | "skipped" | null;
  readonly evidenceFreshness: string | null;
  readonly level: string | null;
  readonly missingChecks: string[];
  readonly missingEvidence: string[];
  readonly failedChecks: string[];
  readonly reason: string | null;
}
export const readVerificationOutcomeRecordedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): VerificationOutcomeRecordedEventPayload => {
  const payload = payloadOf(event);
  const outcome =
    payload.outcome === "pass" || payload.outcome === "fail" || payload.outcome === "skipped"
      ? payload.outcome
      : null;
  const level = typeof payload.level === "string" ? payload.level : null;
  const evidenceFreshness =
    typeof payload.evidenceFreshness === "string" ? payload.evidenceFreshness : null;
  const reason = typeof payload.reason === "string" ? payload.reason : null;
  return {
    outcome,
    evidenceFreshness,
    level,
    missingChecks: Array.isArray(payload.missingChecks)
      ? payload.missingChecks.filter((entry): entry is string => typeof entry === "string")
      : [],
    missingEvidence: Array.isArray(payload.missingEvidence)
      ? payload.missingEvidence.filter((entry): entry is string => typeof entry === "string")
      : [],
    failedChecks: Array.isArray(payload.failedChecks)
      ? payload.failedChecks.filter((entry): entry is string => typeof entry === "string")
      : [],
    reason,
  };
};
export const readVerificationWriteMarkedEventPayload = payloadOf;
export const readWorkbenchBaselineCommittedEventPayload = payloadOf;
export const readWorkbenchEvictionRecordedEventPayload = payloadOf;
export const readWorkbenchEvictionUndoneEventPayload = payloadOf;
export const readWorkbenchNoteRecordedEventPayload = payloadOf;
export const readWorkerResultsAppliedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): WorkerResultsAppliedEventPayload | null =>
  event.payload ? (event.payload as WorkerResultsAppliedEventPayload) : null;

export const TAPE_ANCHOR_SCHEMA = "brewva.tape.anchor.v1" as const;
export const TAPE_CHECKPOINT_SCHEMA = "brewva.tape.checkpoint.v1" as const;
export interface TapeAnchorPayload extends ProtocolRecord {}
export interface TapeCheckpointEvidenceState extends ProtocolRecord {}
export interface TapeCheckpointFailureClassCounts extends ProtocolRecord {}
export interface TapeCheckpointPayload extends ProtocolRecord {}
export interface TapeCheckpointProjectionState extends ProtocolRecord {}
export interface TapeCheckpointToolFailureEntry extends ProtocolRecord {}
export function buildTapeAnchorPayload(input: ProtocolRecord): TapeAnchorPayload {
  return { schema: TAPE_ANCHOR_SCHEMA, ...input };
}
export function buildTapeCheckpointPayload(input: ProtocolRecord): TapeCheckpointPayload {
  return { schema: TAPE_CHECKPOINT_SCHEMA, ...input };
}
export function coerceTapeAnchorPayload(value: unknown): TapeAnchorPayload | null {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : null;
}
export function coerceTapeCheckpointPayload(value: unknown): TapeCheckpointPayload | null {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : null;
}

export const REASONING_CHECKPOINT_SCHEMA = "brewva.reasoning.checkpoint.v1" as const;
export const REASONING_REVERT_SCHEMA = "brewva.reasoning.revert.v1" as const;
export const REASONING_CONTINUITY_SCHEMA = "brewva.reasoning.continuity.v1" as const;
export interface ReasoningCheckpointPayload extends ProtocolRecord {}
export interface ReasoningContinuityPacket extends ProtocolRecord {
  readonly schema: string;
  readonly text: string;
}
export interface ReasoningRevertPayload extends ProtocolRecord {
  readonly revertId?: string;
  readonly toCheckpointId?: string;
  readonly trigger?: string;
  readonly targetLeafEntryId?: string | null;
  readonly linkedRollbackReceiptIds?: readonly string[];
  readonly continuityPacket: ReasoningContinuityPacket;
}
export function buildReasoningCheckpointPayload(input: ProtocolRecord): ReasoningCheckpointPayload {
  return { schema: REASONING_CHECKPOINT_SCHEMA, ...input };
}
export function buildReasoningRevertPayload(input: ProtocolRecord): ReasoningRevertPayload {
  const continuityPacket = isProtocolRecord(input.continuityPacket)
    ? normalizeReasoningContinuityPacket(input.continuityPacket)
    : { schema: REASONING_CONTINUITY_SCHEMA, text: "" };
  return { schema: REASONING_REVERT_SCHEMA, ...input, continuityPacket };
}
export function coerceReasoningCheckpointPayload(
  value: unknown,
): ReasoningCheckpointPayload | null {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : null;
}
export function coerceReasoningRevertPayload(value: unknown): ReasoningRevertPayload | null {
  if (!isProtocolRecord(value)) return null;
  return buildReasoningRevertPayload(value);
}
export function normalizeReasoningContinuityPacket(
  value: ProtocolRecord,
): ReasoningContinuityPacket {
  return {
    ...value,
    schema: stringField(value, "schema", REASONING_CONTINUITY_SCHEMA),
    text: stringField(value, "text", ""),
  };
}
export function coerceReasoningContinuityPacket(value: unknown): ReasoningContinuityPacket | null {
  return isProtocolRecord(value) ? normalizeReasoningContinuityPacket(value) : null;
}
export function buildReasoningRevertSummaryDetails(input: ProtocolRecord): Record<string, unknown> {
  return { ...input };
}

export const WORKBENCH_EVICTION_SPAN_REF_PREFIXES = [
  "turn",
  "message",
  "tool",
  "event",
  "entry",
] as const;
export interface WorkbenchEvictionSpanRef {
  readonly prefix: (typeof WORKBENCH_EVICTION_SPAN_REF_PREFIXES)[number];
  readonly id: string;
  readonly value: string;
  readonly normalized: string;
}
export function listInvalidWorkbenchEvictionSpanRefs(refs: readonly string[]): readonly string[] {
  return refs.filter((ref) => parseWorkbenchEvictionSpanRef(ref) === null);
}
export function normalizeWorkbenchEvictionSpanRefs(refs: readonly string[]): readonly string[] {
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
}
export function parseWorkbenchEvictionSpanRef(ref: string): WorkbenchEvictionSpanRef | null {
  const trimmed = ref.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }
  const prefix = trimmed.slice(0, separator).trim();
  const value = trimmed.slice(separator + 1).trim();
  if (!WORKBENCH_EVICTION_SPAN_REF_PREFIXES.includes(prefix as never)) {
    return null;
  }
  if (value.length === 0) {
    return null;
  }
  return {
    prefix: prefix as (typeof WORKBENCH_EVICTION_SPAN_REF_PREFIXES)[number],
    id: value,
    value,
    normalized: `${prefix}:${value}`,
  };
}

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
export function isLlmVisibleContextEntry(entry: ProtocolRecord): boolean {
  return entry.visible !== false;
}
export function buildSessionRewindProjection(input: ProtocolRecord): ProtocolRecord {
  return { targets: [], ...input };
}
export function listSessionRewindTargets(
  input: ProtocolRecord,
): readonly SessionRewindTargetView[] {
  const targets = input.targets;
  return Array.isArray(targets) ? (targets as SessionRewindTargetView[]) : [];
}
export function normalizeSessionTitleForStorage(value: unknown): string {
  const title = (typeof value === "string" ? value.trim() : "") || DEFAULT_SESSION_TITLE;
  return title.length > SESSION_TITLE_MAX_CHARS ? title.slice(0, SESSION_TITLE_MAX_CHARS) : title;
}
export function projectSessionReplayMetadata(input: ProtocolRecord): ProtocolRecord {
  return input;
}

export interface GuardResultInput extends ProtocolRecord {}
export interface GuardResultPayload extends ProtocolRecord {}
export interface GuardResultQuery extends ProtocolRecord {}
export interface GuardResultRecord extends ProtocolRecord {
  readonly eventId: string;
  readonly guardKey: string;
  readonly status: string;
  readonly iterationKey?: string;
  readonly source: string;
}
export interface IterationFactRecord extends ProtocolRecord {}
export type IterationFactSessionScope = string;
export type IterationGuardStatus = string;
export type IterationMetricAggregation = string;
export interface MetricObservationInput extends ProtocolRecord {}
export interface MetricObservationPayload extends ProtocolRecord {}
export interface MetricObservationQuery extends ProtocolRecord {}
export interface MetricObservationRecord extends ProtocolRecord {
  readonly eventId: string;
  readonly metricKey: string;
  readonly value: number;
  readonly unit?: string;
  readonly aggregation?: string;
  readonly iterationKey?: string;
  readonly source: string;
}
export interface RuntimeCapabilityAccessFact extends ProtocolRecord {
  readonly allowed: boolean;
  readonly basis?: string;
  readonly reason?: string;
  readonly advisory?: string;
}
export interface ToolInvocationStartInput extends ProtocolRecord {
  readonly sessionId?: string;
  readonly callId?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: ProtocolRecord;
  readonly cwd?: string;
  readonly usage?: ContextBudgetUsage;
  readonly diffPreview?: unknown;
  readonly runtimeCapabilityAccess?: RuntimeCapabilityAccessFact;
}
export interface ToolInvocationStartReceipt extends BrewvaEventRecord {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly advisory?: string;
}
export const ITERATION_FACTS_SCHEMA = "brewva.iteration-facts.v1" as const;
export function buildGuardResultPayload(input: ProtocolRecord): GuardResultPayload {
  return input;
}
export function buildMetricObservationPayload(input: ProtocolRecord): MetricObservationPayload {
  return input;
}
export function coerceGuardResultPayload(value: unknown): GuardResultPayload | null {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : null;
}
export function coerceMetricObservationPayload(value: unknown): MetricObservationPayload | null {
  return typeof value === "object" && value !== null ? (value as ProtocolRecord) : null;
}
export function applyFactWindow<T>(records: readonly T[]): readonly T[] {
  return records;
}
export function filterGuardResultRecords(
  records: readonly GuardResultRecord[],
): readonly GuardResultRecord[] {
  return records;
}
export function filterMetricObservationRecords(
  records: readonly MetricObservationRecord[],
): readonly MetricObservationRecord[] {
  return records;
}
export function getGuardResultEventQuery(query: GuardResultQuery): BrewvaEventQuery {
  return query;
}
export function getMetricObservationEventQuery(query: MetricObservationQuery): BrewvaEventQuery {
  return query;
}
export function toGuardResultRecord(input: ProtocolRecord): GuardResultRecord {
  return {
    ...input,
    eventId: typeof input.eventId === "string" ? input.eventId : "",
    guardKey: typeof input.guardKey === "string" ? input.guardKey : "",
    status: typeof input.status === "string" ? input.status : "unknown",
    iterationKey: typeof input.iterationKey === "string" ? input.iterationKey : undefined,
    source: typeof input.source === "string" ? input.source : "runtime",
  };
}
export function toMetricObservationRecord(input: ProtocolRecord): MetricObservationRecord {
  return {
    ...input,
    eventId: typeof input.eventId === "string" ? input.eventId : "",
    metricKey: typeof input.metricKey === "string" ? input.metricKey : "",
    value: typeof input.value === "number" && Number.isFinite(input.value) ? input.value : 0,
    unit: typeof input.unit === "string" ? input.unit : undefined,
    aggregation: typeof input.aggregation === "string" ? input.aggregation : undefined,
    iterationKey: typeof input.iterationKey === "string" ? input.iterationKey : undefined,
    source: typeof input.source === "string" ? input.source : "runtime",
  };
}
