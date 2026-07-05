import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readStringList } from "@brewva/brewva-std/text";
import { type ContextBudgetUsage } from "./context.js";
import {
  payloadOf,
  RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
  type BrewvaEventRecord,
} from "./events.js";
// Single-homed in fitness.ts (where the projection mints it); the receipt only
// carries a copy as claim-time debt. No cycle: fitness -> {review, task}, and
// neither review nor task imports iteration, so `iteration -> fitness` is a DAG.
import { FITNESS_DISCREPANCY_GRADES, type FitnessDiscrepancy } from "./fitness.js";
import {
  INDEPENDENCE_BASES,
  readReviewTargetRef,
  VERIFICATION_RUNGS,
  type IndependenceBasis,
  type ReviewerContext,
  type ReviewTargetRef,
  type VerificationPerspective,
  type VerificationRung,
  type WriteInvocationPath,
} from "./review.js";
import { numberField, optionalStringField } from "./shared.js";
import type { JsonValue, ProtocolRecord } from "./types/foundation.js";

export type {
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  DecisionReceipt,
  EffectCommitmentDiffPreview,
  EffectCommitmentProposal,
  EffectCommitmentRequestListQuery,
  EffectCommitmentRequestRecord,
  EffectCommitmentRequestState,
  PendingEffectCommitmentRequest,
} from "./types/effect-commitment.js";

export type { JsonValue, ProtocolRecord } from "./types/foundation.js";

export const ATTENTION_OPTION_CONSUMED_EVENT_TYPE = "attention.option.consumed" as const;

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

// The durable spelling every claim producer and projection has always
// used; the dead "claim.event" alias was retired by the contract-liveness
// audit (2026-07-02).
export const CLAIM_UPSERTED_EVENT_TYPE = "claim.upserted" as const;

// Kernel canonical approval receipts (the kernel emits these literals
// directly); the dead "effect.commitment.approval.*" aliases were retired by
// the contract-liveness audit (2026-07-02) — consumed-state is derived from
// canonical tool.committed and has no event of its own.
export const APPROVAL_DECIDED_EVENT_TYPE = "approval.decided" as const;

export const APPROVAL_REQUESTED_EVENT_TYPE = "approval.requested" as const;

export const EXEC_FAILED_EVENT_TYPE = "exec.failed" as const;

export const EXEC_STARTED_EVENT_TYPE = "exec.started" as const;

export const MODEL_PRESET_SELECT_EVENT_TYPE = "model_preset_select" as const;

export const MODEL_SELECT_EVENT_TYPE = "model_select" as const;

export const PROVIDER_CREDENTIAL_ROTATED_EVENT_TYPE = "provider_credential_rotated" as const;

export const OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE =
  "observability.assertion.recorded" as const;

export const OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE = "observability.query.executed" as const;

export const REASONING_CHECKPOINT_EVENT_TYPE = "reasoning.checkpoint" as const;

export const REASONING_REVERT_EVENT_TYPE = "reasoning.revert" as const;

export const RECALL_CURATION_RECORDED_EVENT_TYPE = "recall.curation.recorded" as const;

export const RECALL_RESULTS_SURFACED_EVENT_TYPE = "recall.results.surfaced" as const;

export const TOOL_CALL_BLOCKED_EVENT_TYPE = "tool.call.blocked" as const;

export const TOOL_CONTRACT_WARNING_EVENT_TYPE = "tool.contract.warning" as const;

// Underscore on purpose: the ledger-writer artifact chain has always
// written "tool_output_artifact_persisted" and output-search reads it back;
// the durable spelling wins (contract-liveness audit, 2026-07-02).
export const TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE = "tool_output_artifact_persisted" as const;

export const TOOL_OUTPUT_SEARCH_EVENT_TYPE = "tool.output.search" as const;

export const TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE =
  "tool.read_path.discovery.observed" as const;

export const TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE = "tool.read_path.gate.armed" as const;

export const TOOL_RESULT_RECORDED_EVENT_TYPE = "tool.result.recorded" as const;

export const VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE = "verification.outcome.recorded" as const;

export const VERIFICATION_WRITE_MARKED_EVENT_TYPE = "verification.write.marked" as const;

export const ITERATION_FACT_SESSION_SCOPE_VALUES = ["session", "turn"] as const;

export const ITERATION_GUARD_STATUS_VALUES = ["pass", "warn", "fail"] as const;

export const ITERATION_METRIC_AGGREGATION_VALUES = ["sum", "max", "last"] as const;

/**
 * Typed receipt for an explicit `attention_consume`. It sits beside the generic
 * `attention.consume` metric and carries the consumed option/ref identity so a
 * per-entry consume projection can attribute consumption to a specific
 * `WorkbenchEntry`. Selection is an effect; this is its receipt.
 */
export interface AttentionOptionConsumedEventPayload extends ProtocolRecord {
  readonly optionId: string;
  readonly sourceFamily: string;
  readonly refs: readonly string[];
  readonly reason?: string;
}

export interface ResourceLeaseBudget extends ProtocolRecord {
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
  readonly maxParallel?: number;
}

export interface ResourceLeaseRecord extends ProtocolRecord {
  readonly id: string;
  readonly status: string;
  readonly skillName?: string;
  readonly budget: ResourceLeaseBudget;
  readonly expiresAt?: string | null;
  readonly expiresAfterTurn?: number | null;
  readonly reason?: string;
}

export interface ToolLifecycleEventPayload extends ProtocolRecord {}

export interface ToolResultRecordedEventPayload extends ProtocolRecord {
  readonly failureClass: string;
  readonly toolName: string;
  readonly ledgerId?: string;
  readonly verdict?: string;
  readonly failureContext?: ToolOutputDistilledEventPayload | null;
}

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

export interface EvidenceRef extends ProtocolRecord {}

export interface VerifierCheck extends ProtocolRecord {
  readonly status: string;
  readonly summary?: string;
  readonly name?: string;
}

export interface ConvergencePredicate extends ProtocolRecord {}

export interface ClaimLedgerEventPayload extends ProtocolRecord {}

export interface ClaimState extends ProtocolRecord {
  readonly claims: readonly OperationalClaim[];
  readonly updatedAt?: number | null;
}

export interface OperationalClaim extends ProtocolRecord {}

export function createEmptyClaimState(): ClaimState {
  return { claims: [] };
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

export type WorkflowLaneStatus = string;

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

export function classifyToolFailure(input: unknown): string {
  if (typeof input === "string") return input;
  return "unknown";
}

export const readReasoningRevertEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): ReasoningRevertPayload | null =>
  event.payload ? (event.payload as ReasoningRevertPayload) : null;

export interface ToolOutputDistilledEventPayload extends ProtocolRecord {
  readonly outputText?: string;
  readonly args?: ProtocolRecord;
}

export const readToolResultRecordedEventPayload = (event: {
  readonly type?: string;
  readonly payload?: ProtocolRecord;
}): ToolResultRecordedEventPayload => payloadOf(event) as ToolResultRecordedEventPayload;

// VERIFICATION_RUNGS / VerificationRung moved to internal/review.ts:
// projectReviewDebt needs rung ranking, and this module already imports
// review-domain types from review.js, so defining the rungs there (and
// re-exporting here) avoids a circular internal-module dependency. This
// module's public export path (@brewva/brewva-vocabulary/iteration) is
// unchanged for existing callers.
export { VERIFICATION_RUNGS };
export type { VerificationRung };

function readIndependenceBasisArray(value: unknown): IndependenceBasis[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is IndependenceBasis =>
    (INDEPENDENCE_BASES as readonly unknown[]).includes(entry),
  );
}

function readReviewerContext(value: unknown): ReviewerContext | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as ProtocolRecord;
  return {
    model: typeof record.model === "string" ? record.model : null,
    contextId: typeof record.contextId === "string" ? record.contextId : null,
    lenses: Array.isArray(record.lenses)
      ? record.lenses.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export interface VerificationOutcomeRecordedEventPayload extends ProtocolRecord {
  readonly outcome: "pass" | "fail" | "skipped" | null;
  readonly evidenceFreshness: string | null;
  readonly level: string | null;
  readonly checks: string[];
  readonly missingChecks: string[];
  readonly missingEvidence: string[];
  readonly failedChecks: string[];
  readonly reason: string | null;
  readonly perspective: VerificationPerspective;
  readonly independenceBasis: readonly IndependenceBasis[];
  readonly reviewerContext: ReviewerContext | null;
  readonly targetRef: ReviewTargetRef | null;
  /**
   * Claim-time fitness cross-check carried on the receipt (axiom 18: a VIEW, no
   * authority): graded conflicts for atoms this `pass` contradicts — visible
   * debt while `outcome` still says exactly what the caller claimed. Empty for
   * non-`requirements`+/non-`pass` claims and when no atoms exist.
   */
  readonly discrepancies: readonly FitnessDiscrepancy[];
  /** Ids of unmet `must`-modality atoms (no live evidence bears on them). */
  readonly unverifiedMustAtoms: readonly string[];
  /**
   * The requirement atoms THIS outcome affirmatively attests to. Populated only
   * by a clear (pass) independent atoms-review — it is the receipt's positive
   * signal that a reviewer confirmed those atoms are realized, letting the
   * fitness projection reach `satisfied`. A FACT the receipt carries (which
   * atoms this outcome vouches for), not a re-derivable count, so it lives here
   * and is read back, not recomputed. Empty on every non-atoms/non-clear
   * outcome (a fail NEVER lists atoms — findings own violations).
   */
  readonly atomRefs: readonly string[];
}

/**
 * Defensive reader for the receipt's fitness annotation: a non-array yields
 * `[]`, and any entry that is not a well-formed {@link FitnessDiscrepancy}
 * (non-object, unknown grade, or a missing/non-string required field) is DROPPED
 * rather than crashing the read — matching the atom-enrichment coercion style.
 */
function isFitnessDiscrepancy(value: unknown): value is FitnessDiscrepancy {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as ProtocolRecord;
  return (
    typeof record.atomId === "string" &&
    (FITNESS_DISCREPANCY_GRADES as readonly unknown[]).includes(record.grade) &&
    typeof record.statement === "string" &&
    typeof record.evidenceRef === "string"
  );
}

function readFitnessDiscrepancies(value: unknown): FitnessDiscrepancy[] {
  return Array.isArray(value) ? value.filter(isFitnessDiscrepancy) : [];
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
  // Every historical receipt was author-produced (no receipt ever recorded a
  // perspective before this field existed), so "authored" is the semantic
  // default, not a compatibility shim: anything other than the literal
  // "independent" coerces to it.
  const perspective: VerificationPerspective =
    payload.perspective === "independent" ? "independent" : "authored";
  return {
    outcome,
    evidenceFreshness,
    level,
    checks: readStringList(payload.checks),
    missingChecks: readStringList(payload.missingChecks),
    missingEvidence: readStringList(payload.missingEvidence),
    failedChecks: readStringList(payload.failedChecks),
    reason,
    perspective,
    independenceBasis: readIndependenceBasisArray(payload.independenceBasis),
    reviewerContext: readReviewerContext(payload.reviewerContext),
    targetRef: readReviewTargetRef(payload.targetRef),
    discrepancies: readFitnessDiscrepancies(payload.discrepancies),
    unverifiedMustAtoms: readStringList(payload.unverifiedMustAtoms),
    // Mirrors the review-finding payload's atomRefs coercion: missing/malformed
    // → [], non-string entries filtered. A pre-existing receipt reads back [].
    atomRefs: Array.isArray(payload.atomRefs)
      ? payload.atomRefs.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
};

/**
 * Write-class tool names used to detect "fresh code was written this
 * session" — the shared basis for the post-green review nudge (gateway
 * skill-adoption) and the intent-realization loop's own fresh-code signal.
 * One definition; skill-adoption imports it instead of holding its own copy.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "source_patch_apply",
]);

/**
 * The minimal invocation-started event shape the fresh-code scan reads.
 * `timestamp` is optional so the pure boolean/path scans that never need it can
 * pass a bare `{type, payload}`; the callers' real events ({@link BrewvaEventRecord})
 * always carry it, which is what {@link deriveLatestTreeMutationAt} folds over.
 */
export interface FreshCodeScanEvent {
  readonly type: string;
  readonly timestamp?: number;
  readonly payload?: unknown;
}

/**
 * Pure scan: did any invocation of a {@link WRITE_TOOL_NAMES} tool actually
 * execute this session? A blocked invocation (`payload.allowed === false`)
 * never ran, so it does not count — the model saw nothing and touched
 * nothing. Shared by the gateway's post-green review signal
 * (`projectPostGreenReviewSignal`) and the tools-side review-debt projection's
 * effectful shell, so the fresh-code definition lives in exactly one place
 * instead of two independently-drifting copies of the same invocation scan.
 */
export function projectFreshCodeWritten(
  events: readonly FreshCodeScanEvent[],
  invocationKind: string = RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
): boolean {
  for (const event of events) {
    if (event.type !== invocationKind) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;
    const record = payload as { toolName?: unknown; allowed?: unknown };
    if (record.allowed === false) continue;
    if (typeof record.toolName === "string" && WRITE_TOOL_NAMES.has(record.toolName)) {
      return true;
    }
  }
  return false;
}

/**
 * Bare-write tools whose target FILE path must be read from their invocation
 * args to build the fresh-touched-file universe (Finding P1-C). This is a
 * SUBSET of {@link WRITE_TOOL_NAMES}: `source_patch_apply` is excluded because
 * its touched paths come authoritatively from the `source_patch_applied`
 * receipt's `appliedPaths` (folded into the universe separately), not from its
 * invocation args — counting it here would double-source and could miss the
 * real applied set.
 */
const BARE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * THE single predicate for "this invocation-started payload is a bare-write
 * (write/edit) that actually ran." Single-homed so the two consumers that must
 * agree on the write set — {@link extractWriteInvocationPaths} (the touched-file
 * universe) and {@link deriveLatestTreeMutationAt} (the tree-mutation timestamp)
 * — select the exact same events. A blocked invocation (`allowed === false`)
 * never ran, so it is excluded; anything else (including `allowed` omitted) is
 * the conservative superset the universe already uses. Callers pre-filter to the
 * invocation-started kind, so this only checks the payload's toolName/allowed.
 */
function isBareWriteInvocationPayload(payload: unknown): payload is { readonly args?: unknown } {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const record = payload as { toolName?: unknown; allowed?: unknown };
  if (record.allowed === false) {
    return false;
  }
  return typeof record.toolName === "string" && BARE_WRITE_TOOL_NAMES.has(record.toolName);
}

function readWriteArgPath(args: unknown): string | null {
  if (!args || typeof args !== "object") {
    return null;
  }
  const record = args as { path?: unknown; file_path?: unknown; filePath?: unknown; uri?: unknown };
  for (const candidate of [record.path, record.file_path, record.filePath, record.uri]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Extract each bare-write (write/edit) invocation's target path from the tape,
 * as {@link WriteInvocationPath} entries for
 * {@link deriveFreshTouchedFileUniverse} (Finding P1-C). A blocked invocation
 * (`allowed === false`) never ran, so it is skipped entirely. A write that ran
 * but whose path can NOT be parsed yields `{ path: null }`, which makes the
 * universe not-fully-known downstream (conservative: coverage can never be
 * proven, so debt shows rather than falsely clears). The invocation `cwd` is
 * carried so an absolute target can be made workspace-relative for coverage
 * comparison. Single-homed here so both the live and tape debt shells derive
 * the write set through ONE definition, mirroring `projectFreshCodeWritten`.
 */
export function extractWriteInvocationPaths(
  events: readonly FreshCodeScanEvent[],
  invocationKind: string = RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
): WriteInvocationPath[] {
  const paths: WriteInvocationPath[] = [];
  for (const event of events) {
    if (event.type !== invocationKind) continue;
    const payload = event.payload;
    if (!isBareWriteInvocationPayload(payload)) continue;
    const record = payload as { args?: unknown; cwd?: unknown };
    const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : null;
    paths.push({ path: readWriteArgPath(record.args), cwd });
  }
  return paths;
}

/**
 * Pure, deterministic fold: the latest tape timestamp at which the working tree
 * was mutated, or null when nothing mutated it. SINGLE-HOMED here (Finding P1)
 * so the tape-only review-debt read (`buildTapeReviewDebt`) and the
 * requirement-fitness assembler (`assembleRequirementFitnessInput`) compute the
 * SAME `latestTreeMutationAt` the tape-only staleness matcher
 * (`reviewTargetRefMatchesTapeOnly`) consumes — instead of two inline
 * reductions that both wrongly counted only patch/rollback.
 *
 * A tree mutation is:
 *  (a) a `source_patch_applied` OR `rollback.recorded` receipt with
 *      `payload.ok === true` — an application writes the patch, a rollback
 *      restores prior files; both rewrite the tree. Failed events (`ok !== true`)
 *      never touched the tree and are excluded (matching `deriveAppliedPatchSetIds`).
 *  (b) a bare-write (write/edit) invocation that ran — selected by the EXACT
 *      same predicate the touched-file universe uses
 *      ({@link isBareWriteInvocationPayload}, shared with
 *      {@link extractWriteInvocationPaths}). A bare `write`/`edit` mutates the
 *      tree just like a patch application, so it MUST advance the timestamp; the
 *      prior omission let a bare edit after an independent receipt leave that
 *      receipt wrongly FRESH.
 *
 * Conservatism (same superset the universe already uses): a bare-write
 * invocation that was allowed but may have FAILED still advances the timestamp.
 * This can only age a receipt to stale (an honest "we don't know if it is still
 * fresh"), never falsely keep a stale receipt live — an under-claim of freshness
 * at worst, never an over-claim.
 *
 * Callers pass their already-filtered event arrays: `patchRollbackEvents` is the
 * `source_patch_applied`/`rollback.recorded` slice; `writeInvocationEvents` is
 * the invocation-started slice. No I/O, no clock.
 */
export function deriveLatestTreeMutationAt(input: {
  readonly patchRollbackEvents: readonly FreshCodeScanEvent[];
  readonly writeInvocationEvents: readonly FreshCodeScanEvent[];
}): number | null {
  let latest: number | null = null;
  const advance = (timestamp: number | undefined): void => {
    if (typeof timestamp !== "number") return;
    latest = latest === null ? timestamp : Math.max(latest, timestamp);
  };
  for (const event of input.patchRollbackEvents) {
    const payload = event.payload;
    if (payload && typeof payload === "object" && (payload as { ok?: unknown }).ok === true) {
      advance(event.timestamp);
    }
  }
  for (const event of input.writeInvocationEvents) {
    if (isBareWriteInvocationPayload(event.payload)) {
      advance(event.timestamp);
    }
  }
  return latest;
}

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

export function buildReasoningRevertSummaryDetails(input: ProtocolRecord): Record<string, unknown> {
  return { ...input };
}

export interface GuardResultInput extends ProtocolRecord {}

export interface GuardResultQuery extends ProtocolRecord {}

export interface GuardResultRecord extends ProtocolRecord {
  readonly eventId: string;
  readonly guardKey: string;
  readonly status: string;
  readonly iterationKey?: string;
  readonly source: string;
}

export interface MetricObservationInput extends ProtocolRecord {}

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

export interface AttentionConsumptionQuery extends ProtocolRecord {}

export interface AttentionConsumptionRecord extends ProtocolRecord {
  readonly eventId: string;
  readonly optionId: string;
  readonly sourceFamily: string;
  readonly refs: readonly string[];
  readonly reason?: string;
  readonly consumedAt?: number;
}

export interface AttentionEntryConsumption {
  readonly entryId: string;
  readonly consumeCount: number;
  readonly lastConsumedAt?: number;
}

const WORKBENCH_ATTENTION_OPTION_PREFIX = "workbench:";

/**
 * Per-entry consume projection over `attention.option.consumed` receipts. It
 * counts how many times each `WorkbenchEntry` was explicitly consumed and the
 * latest time it happened. This is a read-model derivation; neither the count
 * nor the timestamp is ever stored on the entry.
 */
export function projectAttentionEntryConsumption(
  records: readonly AttentionConsumptionRecord[],
): AttentionEntryConsumption[] {
  const byEntry = new Map<string, { count: number; lastConsumedAt?: number }>();
  for (const record of records) {
    if (!record.optionId.startsWith(WORKBENCH_ATTENTION_OPTION_PREFIX)) {
      continue;
    }
    const entryId = record.optionId.slice(WORKBENCH_ATTENTION_OPTION_PREFIX.length);
    if (entryId.length === 0) {
      continue;
    }
    const current = byEntry.get(entryId) ?? { count: 0 };
    const lastConsumedAt =
      typeof record.consumedAt === "number" && Number.isFinite(record.consumedAt)
        ? Math.max(current.lastConsumedAt ?? record.consumedAt, record.consumedAt)
        : current.lastConsumedAt;
    byEntry.set(entryId, { count: current.count + 1, lastConsumedAt });
  }
  return [...byEntry.entries()].map(([entryId, aggregate]) =>
    aggregate.lastConsumedAt === undefined
      ? { entryId, consumeCount: aggregate.count }
      : {
          entryId,
          consumeCount: aggregate.count,
          lastConsumedAt: aggregate.lastConsumedAt,
        },
  );
}

export interface RuntimeCapabilityAccessFact extends ProtocolRecord {
  readonly allowed: boolean;
  readonly basis?: string;
  readonly reason?: string;
  readonly advisory?: string;
  readonly receiptId?: string;
  readonly source?: string;
  readonly selectedCapabilityNames?: readonly string[];
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
  readonly receiptId?: string;
  readonly source?: string;
  readonly selectedCapabilityNames?: readonly string[];
}
