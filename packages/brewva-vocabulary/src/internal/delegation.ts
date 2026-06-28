import { type BrewvaEventRecord } from "./events.js";
import { type VerifierCheck } from "./iteration.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

export type { WorkerApplyReport, WorkerMergeReport, WorkerResult } from "./types/patch.js";

export const CURRENT_DELEGATION_CONTRACT_VERSION = 4 as const;

export const SUBAGENT_CANCELLED_EVENT_TYPE = "subagent_cancelled" as const;

export const SUBAGENT_COMPLETED_EVENT_TYPE = "subagent_completed" as const;

export const SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE = "subagent_delivery_surfaced" as const;

export const SUBAGENT_FAILED_EVENT_TYPE = "subagent_failed" as const;

export const SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE =
  "subagent.knowledge_adoption.recorded" as const;

export const SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE = "subagent_outcome_parse_failed" as const;

export const SUBAGENT_RUNNING_EVENT_TYPE = "subagent_running" as const;

export const SUBAGENT_SPAWNED_EVENT_TYPE = "subagent_spawned" as const;

export const WORKER_RESULTS_APPLIED_EVENT_TYPE = "worker.results.applied" as const;

export const WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE = "worker.results.apply_failed" as const;

export const WORKER_RESULTS_REJECTED_EVENT_TYPE = "worker.results.rejected" as const;

// Runtime-ops worker-result record event: emitted by the hosted session builder and folded
// by the runtime-ops worker-results projection. Shared so emit and projection never drift.
export const WORKER_RESULT_RECORDED_EVENT_TYPE = "worker.result.recorded" as const;

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

export const REVIEW_LANE_NAMES = [
  "review-correctness",
  "review-boundaries",
  "review-operability",
  "review-security",
  "review-concurrency",
  "review-compatibility",
  "review-performance",
] as const;

export type ReviewLaneName = (typeof REVIEW_LANE_NAMES)[number];

export type DelegationRunStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type DelegationLifecycleReason =
  | "timeout"
  | "user"
  | "policy"
  | "crash"
  | "missing_evidence"
  | "approval_wait"
  | "none";

export type DelegationRetentionPosture = "live" | "archived";

export type DelegationResultMode = "evidence" | "consult" | "patch" | "verifier" | "knowledge";

export type DelegationAdoptionRequirement = "patch_apply" | "knowledge_adopt" | "none";

/**
 * The closed set of delegation execution archetypes. An archetype is the
 * physics class of a delegated run — its effect boundary and workspace
 * isolation — and is the only execution envelope the hosted control plane
 * validates. Delegation capsules (the navigator/explorer/worker/verifier/
 * librarian personas and any workspace extensions) bind exactly one archetype
 * and may only narrow it (drop tools, shrink budgets), never widen it.
 *
 * - `readonly-shared`: safe, shared workspace, read-only. Hosts evidence,
 *   judgment, and knowledge personas (navigator, explorer, librarian, review
 *   lanes). Never produces patches.
 * - `patch-snapshot`: effectful, copy-on-write snapshot workspace. Produces a
 *   `PatchSet` that the parent must explicitly adopt. Hosts the worker persona.
 * - `exec-ephemeral`: effectful, ephemeral execution sandbox, non-mutating.
 *   Hosts the verifier persona.
 */
export type DelegationEnvelopeArchetype = "readonly-shared" | "patch-snapshot" | "exec-ephemeral";

export const DELEGATION_ENVELOPE_ARCHETYPES: readonly DelegationEnvelopeArchetype[] = [
  "readonly-shared",
  "patch-snapshot",
  "exec-ephemeral",
];

/**
 * The single source of truth for what a delegated result obliges the parent to
 * do. Adoption is an axis orthogonal to the execution archetype, carried by the
 * result contract: a `patch` result must be merged/applied, a `knowledge`
 * proposal must be explicitly adopted (the librarian runs on a read-only
 * archetype yet still requires this), and evidence/consult/verifier results are
 * advisory with no adoption obligation.
 */
export function deriveDelegationAdoptionRequirement(
  resultMode: DelegationResultMode,
): DelegationAdoptionRequirement {
  if (resultMode === "patch") {
    return "patch_apply";
  }
  if (resultMode === "knowledge") {
    return "knowledge_adopt";
  }
  return "none";
}

export type PublicSubagentRole = "navigator" | "explorer" | "worker" | "verifier" | "librarian";

export type DelegationVisibility = "public" | "internal" | "diagnostic";

export type DelegationIsolationStrategy =
  | "shared"
  | "snapshot"
  | "worktree"
  | "ephemeral_exec"
  | "a2a_channel";

export type NavigatorDelegationDisposition = "unread" | "consumed";
export type ExplorerDelegationDisposition = "unread" | "consumed";
export type WorkerDelegationDisposition =
  | "pending_apply"
  | "prepared"
  | "applied"
  | "apply_failed"
  | "rejected"
  | "superseded";
export type VerifierDelegationDisposition = "unread" | "consulted" | "stale" | "superseded";
export type LibrarianDelegationDisposition =
  | "pending_knowledge_adopt"
  | "adopted"
  | "rejected"
  | "deferred";

export type DelegationRunDisposition =
  | NavigatorDelegationDisposition
  | ExplorerDelegationDisposition
  | WorkerDelegationDisposition
  | VerifierDelegationDisposition
  | LibrarianDelegationDisposition;

export interface DelegationRunCard {
  readonly runId: string;
  readonly role: PublicSubagentRole;
  readonly resultMode: DelegationResultMode;
  readonly lifecycle: DelegationRunStatus;
  readonly lifecycleReason: DelegationLifecycleReason;
  readonly retention: DelegationRetentionPosture;
  readonly disposition: DelegationRunDisposition;
  readonly adoptionRequirement: DelegationAdoptionRequirement;
  readonly title: string;
  readonly taskPath?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly isolation: DelegationIsolationStrategy;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly eventId: string;
  readonly canonicalRefs: readonly string[];
}

export interface DelegationWorkboardProjection {
  readonly pendingWorkerPatches: readonly DelegationRunCard[];
  readonly pendingKnowledgeAdoptions: readonly DelegationRunCard[];
  readonly unreadEvidence: readonly DelegationRunCard[];
  readonly verificationDebt: readonly DelegationRunCard[];
  readonly blockedOrFailedRuns: readonly DelegationRunCard[];
}

export type DelegationInboxItemKind =
  | "worker_patch"
  | "librarian_knowledge"
  | "delegation_evidence"
  | "verification_debt"
  | "failed_run";

export interface DelegationInboxItem {
  readonly itemId: string;
  readonly kind: DelegationInboxItemKind;
  readonly runId: string;
  readonly title: string;
  readonly summary?: string;
  readonly disposition: DelegationRunDisposition;
  readonly adoptionRequirement: DelegationAdoptionRequirement;
  readonly eventId: string;
  readonly canonicalRefs: readonly string[];
}

export interface DelegationInboxProjection {
  readonly items: readonly DelegationInboxItem[];
  readonly explicitPull: true;
}

/**
 * Adoption board projection.
 *
 * The board partitions pending delegation work into two kinds that must never
 * be conflated:
 *
 * - `adoptionItems`: work blocked on an explicit parent authority decision — a
 *   worker `PatchSet` to merge/apply/reject, or a librarian knowledge proposal
 *   to adopt/reject/defer. Each item names the tool(s) that resolve it (the
 *   `description` notes any multi-step shape, e.g. worker apply is
 *   prepare-then-apply). This axis is the result contract's adoption
 *   requirement, orthogonal to the execution archetype.
 * - `attentionItems`: advisory debt that needs parent awareness but no adoption
 *   decision — unconsumed evidence/consult outcomes, verifier evidence (which
 *   surfaces as verification debt, never as patch adoption), and blocked/failed
 *   runs.
 *
 * The board owns no truth: it is a pure re-partition of the run cards and never
 * mutates adoption state. Resolution is always an explicit, separate tool call.
 */
export type DelegationAdoptionItemKind = "worker_patch" | "knowledge_proposal";

export type DelegationAttentionItemKind = "advisory_outcome" | "verification_debt" | "blocked_run";

export interface DelegationAdoptionResolution {
  /** The exact tool that records this decision. */
  readonly tool: string;
  /** The decision value the tool records (e.g. `apply`, `reject`, `accept`, `defer`). */
  readonly decision: string;
  readonly description: string;
}

export interface DelegationAdoptionItem {
  readonly runId: string;
  readonly kind: DelegationAdoptionItemKind;
  readonly role: PublicSubagentRole;
  readonly title: string;
  readonly summary?: string;
  readonly disposition: DelegationRunDisposition;
  readonly adoptionRequirement: DelegationAdoptionRequirement;
  /** The tool call(s) the parent can make to resolve this item. */
  readonly resolutions: readonly DelegationAdoptionResolution[];
  readonly eventId: string;
  readonly canonicalRefs: readonly string[];
}

export interface DelegationAttentionItem {
  readonly runId: string;
  readonly kind: DelegationAttentionItemKind;
  readonly role: PublicSubagentRole;
  readonly title: string;
  readonly summary?: string;
  readonly disposition: DelegationRunDisposition;
  /** Why the item needs awareness; advisory only, never an adoption obligation. */
  readonly reason: string;
  readonly eventId: string;
  readonly canonicalRefs: readonly string[];
}

export interface DelegationAdoptionBoard {
  readonly adoptionItems: readonly DelegationAdoptionItem[];
  readonly attentionItems: readonly DelegationAttentionItem[];
  readonly explicitPull: true;
}

export type DelegationTimelineGroupKind =
  | "turn"
  | "tool"
  | "delegation"
  | "verification"
  | "adoption"
  | "recovery"
  | "other";

export interface DelegationTimelineGroup {
  readonly groupId: string;
  readonly kind: DelegationTimelineGroupKind;
  readonly timestamp: number;
  readonly turn?: number;
  readonly title: string;
  readonly summary: string;
  readonly eventIds: readonly string[];
  readonly canonicalRefs: readonly string[];
}

export interface DelegationReplayTimeline {
  readonly groups: readonly DelegationTimelineGroup[];
  readonly explicitPull: true;
}

export type RecoveryPrimitive =
  | { readonly kind: "resume" }
  | { readonly kind: "reasoning_revert"; readonly linkedRollback?: readonly string[] }
  | { readonly kind: "session_rewind"; readonly scope: "conversation" | "code" | "both" }
  | { readonly kind: "rollback_last_patch" }
  | {
      readonly kind: "reject_adoption";
      readonly target: "worker_patch" | "librarian_knowledge";
      readonly runId: string;
    };

export type RecoveryContinuationAnchor = {
  readonly kind: "event" | "baseline" | "branch";
  readonly id: string;
};

export interface RecoveryPreview {
  readonly continuationAnchor: RecoveryContinuationAnchor;
  readonly activeBaseline?: string;
  readonly activeTrust: {
    readonly toolCalls: number;
    readonly approvals: number;
    readonly mutations: number;
    readonly workerResults: number;
    readonly verifierEvidence: number;
  };
  readonly primitives: readonly RecoveryPrimitive[];
  readonly nextReceiptOwner: "parent" | "child" | "system";
}

export interface DelegationInspectionProjection {
  readonly sessionId: string;
  readonly runCards: readonly DelegationRunCard[];
  readonly workboard: DelegationWorkboardProjection;
  readonly adoptionBoard: DelegationAdoptionBoard;
  readonly inbox: DelegationInboxProjection;
  readonly timeline: DelegationReplayTimeline;
  readonly recoveryPreview: RecoveryPreview;
}

export interface DelegationRunRecord {
  readonly contractVersion: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  readonly runId: string;
  readonly parentSessionId: string;
  readonly agent: PublicSubagentRole;
  readonly targetName: string;
  readonly taskName: string;
  readonly taskPath: string;
  readonly depth: number;
  readonly forkTurns: DelegationForkTurns;
  readonly gateReason: string;
  readonly modelCategory: DelegationModelCategory;
  readonly delegate: string;
  readonly status: DelegationRunStatus;
  readonly lifecycleReason?: DelegationLifecycleReason;
  readonly retention?: DelegationRetentionPosture;
  readonly adoptionRequirement?: DelegationAdoptionRequirement;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly label?: string;
  readonly nickname?: string;
  readonly kind?: DelegationResultMode;
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

export interface DelegationLifecycleEventPayload extends ProtocolRecord {
  readonly contractVersion?: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  readonly runId?: string;
  readonly agent?: PublicSubagentRole;
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
  readonly lifecycleReason?: DelegationLifecycleReason;
  readonly retention?: DelegationRetentionPosture;
  readonly adoptionRequirement?: DelegationAdoptionRequirement;
  readonly label?: string;
  readonly childSessionId?: string;
  readonly parentSkill?: string;
  readonly kind?: DelegationResultMode;
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

export interface DelegationModelRouteRecord extends ProtocolRecord {
  readonly selectedModel?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly policyId?: string;
  readonly presetName?: string;
  readonly category?: string;
  readonly role?: string;
  readonly presetMissReason?: string;
  readonly reason?: string;
  readonly source?: DelegationModelRouteSource;
}

export type DelegationModelRouteSource = string;

export interface PendingDelegationOutcomeQuery extends ProtocolRecord {
  readonly limit?: number;
}

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

export function isDelegationRunTerminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

export function evaluateDelegationAdoption(input: ProtocolRecord): DelegationAdoptionDecision {
  return Object.freeze({ adopt: true, ...input });
}

export type ReviewPrecedentConsultStatus = string;

export interface ReviewReportArtifact extends ProtocolRecord {}

export interface DesignExecutionStep extends ProtocolRecord {}

export interface DesignImplementationTarget extends ProtocolRecord {}

export interface DesignRiskItem extends ProtocolRecord {}

export function normalizeReviewLaneName(value: unknown): ReviewLaneName | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return (REVIEW_LANE_NAMES as readonly string[]).includes(normalized)
    ? (normalized as ReviewLaneName)
    : undefined;
}

export function deriveParallelBudgetStateFromEvents(
  events: readonly BrewvaEventRecord[],
): DerivedParallelBudgetState {
  const activeRunIds = new Set<string>();
  let totalStarted = 0;
  let maxConcurrent = 0;
  let latestEventId: string | undefined;

  for (const event of events) {
    latestEventId = event.id;
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload
        : {};
    const runId = typeof payload.runId === "string" ? payload.runId : undefined;
    if (!runId) {
      continue;
    }
    if (event.type === SUBAGENT_SPAWNED_EVENT_TYPE) {
      totalStarted += 1;
      activeRunIds.add(runId);
      maxConcurrent = Math.max(maxConcurrent, activeRunIds.size);
      continue;
    }
    if (event.type === SUBAGENT_RUNNING_EVENT_TYPE) {
      activeRunIds.add(runId);
      maxConcurrent = Math.max(maxConcurrent, activeRunIds.size);
      continue;
    }
    if (
      event.type === SUBAGENT_COMPLETED_EVENT_TYPE ||
      event.type === SUBAGENT_FAILED_EVENT_TYPE ||
      event.type === SUBAGENT_CANCELLED_EVENT_TYPE
    ) {
      activeRunIds.delete(runId);
    }
  }

  return {
    eventCount: events.length,
    activeRunIds: [...activeRunIds],
    activeCount: activeRunIds.size,
    maxConcurrent: maxConcurrent > 0 ? maxConcurrent : null,
    totalStarted,
    ...(latestEventId ? { latestEventId } : {}),
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

/**
 * Parallel-slot admission vocabulary.
 *
 * A slot is a unit of concurrent session work governed by the parallel
 * admission gate. Two kinds share one ceiling:
 *
 * - `delegation`: a child subagent run. Its active membership is replay-derived
 *   from `subagent_spawned`/terminal events (see
 *   `deriveParallelBudgetStateFromEvents`) and it counts against the session
 *   lifetime cap (`maxTotalPerSession`).
 * - `transient`: best-effort in-process concurrency (e.g. parallel file-read
 *   batches). It is never durable, never counts against the lifetime cap, and
 *   evaporates on restart.
 */
export type ParallelSlotKind = "delegation" | "transient";

export type ParallelSlotRejectionReason =
  | "max_concurrent_reached"
  | "session_total_exhausted"
  | "wait_timeout";

export interface ParallelSlotAcquireOptions {
  readonly kind?: ParallelSlotKind;
  /** Bounded wait budget for the async acquire posture, in milliseconds. */
  readonly timeoutMs?: number;
}

export type ParallelSlotDecision =
  | { readonly accepted: true; readonly waited?: boolean }
  | {
      readonly accepted: false;
      readonly reason: ParallelSlotRejectionReason;
      readonly waited?: boolean;
    };

/**
 * The canonical parallel-slot admission port. Shared by the public tool runtime
 * contract and the hosted controller so the surface has a single definition.
 */
export interface ParallelSlotPort {
  acquire(
    sessionId: string,
    runId: string,
    options?: ParallelSlotAcquireOptions,
  ): ParallelSlotDecision;
  acquireAsync(
    sessionId: string,
    runId: string,
    options?: ParallelSlotAcquireOptions,
  ): Promise<ParallelSlotDecision>;
  release(sessionId: string, runId: string): void;
}

export interface ParallelSlotEventPayload extends ProtocolRecord {
  readonly runId: string;
  readonly kind: ParallelSlotKind;
  readonly activeCount: number;
  readonly ceiling: number;
  readonly totalStarted: number;
  readonly maxTotalPerSession: number;
  readonly reason?: ParallelSlotRejectionReason;
  readonly leaseRaisedCeiling?: boolean;
  readonly waited?: boolean;
}

export const SUBAGENT_SLOT_ACQUIRED_EVENT_TYPE = "subagent_slot_acquired" as const;

export const SUBAGENT_SLOT_REJECTED_EVENT_TYPE = "subagent_slot_rejected" as const;

export const SUBAGENT_SLOT_WAITING_EVENT_TYPE = "subagent_slot_waiting" as const;

export const SUBAGENT_SLOT_RELEASED_EVENT_TYPE = "subagent_slot_released" as const;

export function isWaitableParallelSlotRejection(reason: ParallelSlotRejectionReason): boolean {
  // Concurrency pressure can clear when a peer releases; a lifetime-cap or
  // wait-timeout rejection cannot be resolved by waiting.
  return reason === "max_concurrent_reached";
}

export const readDelegationLifecycleEventPayload = (event: {
  readonly payload?: ProtocolRecord;
  readonly type?: string;
}): DelegationLifecycleEventPayload | null =>
  event.payload ? (event.payload as DelegationLifecycleEventPayload) : null;

export const readWorkerResultsAppliedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): WorkerResultsAppliedEventPayload | null =>
  event.payload ? (event.payload as WorkerResultsAppliedEventPayload) : null;
