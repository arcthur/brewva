import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ContextBudgetUsage } from "./context.js";
import { payloadOf, type BrewvaEventRecord } from "./events.js";
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

export const CLAIM_EVENT_TYPE = "claim.event" as const;

export const DECISION_RECEIPT_RECORDED_EVENT_TYPE = "decision.receipt.recorded" as const;

export const EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE =
  "effect.commitment.approval.consumed" as const;

export const EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE =
  "effect.commitment.approval.decided" as const;

export const EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE =
  "effect.commitment.approval.requested" as const;

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

export const RECALL_UTILITY_OBSERVED_EVENT_TYPE = "recall.utility.observed" as const;

export const TOOL_CALL_BLOCKED_EVENT_TYPE = "tool.call.blocked" as const;

export const TOOL_CONTRACT_WARNING_EVENT_TYPE = "tool.contract.warning" as const;

export const TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE = "tool.output.artifact.persisted" as const;

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
