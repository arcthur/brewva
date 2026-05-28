import type { ToolActionClass } from "@brewva/brewva-runtime/security";
import type { SessionPhase } from "@brewva/brewva-substrate/session";
import type { RuntimeCostPosture } from "@brewva/brewva-tools/contracts";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type {
  SessionRewindTargetView,
  TaskWorkCardProjection,
} from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { ContextCockpitReport } from "../../../operator/inspect/context-cockpit.js";
import type { OperatorSurfaceSnapshot } from "../operator-snapshot.js";

export const SHELL_COCKPIT_PROJECTION_SCHEMA_V1 = "brewva.shell-cockpit.projection.v1" as const;

export type ShellCockpitSurfaceRegion =
  | "physics_bar"
  | "current_work_card"
  | "decision_lane"
  | "effect_ledger"
  | "attention_glance"
  | "recovery_lane"
  | "composer";

export type CockpitFreshness = "stale" | "settled" | "fresh" | "just_now";

export interface CockpitObservationCursor {
  readonly lastObservedAtRef?: string;
  readonly focusedRef?: string;
  readonly operatorPinnedRefs: readonly string[];
}

export type CockpitArchiveKind =
  | "transcript"
  | "event_tape"
  | "receipt"
  | "tool_output"
  | "context"
  | "replay";

export interface CockpitArchiveRef {
  readonly kind: CockpitArchiveKind;
  readonly ref: string;
  readonly label: string;
}

export interface ShellCockpitPhysicsBar {
  readonly phase: {
    readonly kind: SessionPhase["kind"] | "unknown";
    readonly label: string;
    readonly tone: "quiet" | "steady" | "working" | "blocked" | "critical";
    readonly salience: "muted" | "default" | "elevated" | "alert";
    readonly blockingComposer: boolean;
    readonly refs: readonly string[];
  };
  readonly providerLabel: string | null;
  readonly modelLabel: string | null;
  readonly context: {
    readonly pressure: TaskWorkCardProjection["context"]["pressure"];
    readonly workbenchEntryCount: number;
    readonly compactBaselineRef: string | null;
  };
  readonly cost: RuntimeCostPosture;
  readonly costObservedAtRef: string | null;
  readonly cachePosture: ContextCockpitReport["cachePosture"];
  readonly sandboxPosture: ShellCockpitSandboxPosture;
}

export type ShellCockpitSandboxPosture =
  | "unknown"
  | "read_only"
  | "workspace_write"
  | "unrestricted"
  | "restricted";

export type ShellCockpitComposerPolicy = "active" | "muted" | "stash" | "queue" | "block";

export type ShellCockpitDecisionKind =
  | "approval"
  | "question"
  | "cost_gate"
  | "adoption"
  | "recovery_confirm"
  | "manual_gate";

export type ShellCockpitDecisionActionKind =
  | "approve"
  | "deny"
  | "answer"
  | "review_cost"
  | "adopt"
  | "rewind"
  | "dismiss";

export interface ShellCockpitDecisionAction {
  readonly kind: ShellCockpitDecisionActionKind;
  readonly label: string;
  readonly ref?: string;
}

interface ShellCockpitDecisionBase {
  readonly ref: string;
  readonly title: string;
  readonly sourceRef: string;
  readonly stateChangedAt: number;
  readonly freshness: CockpitFreshness;
  readonly pinned: boolean;
  readonly actions: readonly ShellCockpitDecisionAction[];
}

export interface ShellCockpitApprovalDecisionItem extends ShellCockpitDecisionBase {
  readonly kind: "approval";
  readonly requestId: string;
  readonly toolName: string;
  readonly boundary: string;
  readonly diffRef?: string;
  readonly patchRef?: string;
  readonly detail: string;
}

export interface ShellCockpitQuestionDecisionItem extends ShellCockpitDecisionBase {
  readonly kind: "question";
  readonly questionId: string;
  readonly inputContract: {
    readonly kind: "free_text" | "choice";
    readonly optionCount: number;
    readonly allowFreeText: boolean;
  };
  readonly detail: string;
}

export interface ShellCockpitCostGateDecisionItem extends ShellCockpitDecisionBase {
  readonly kind: "cost_gate";
  readonly posture: RuntimeCostPosture;
  readonly detail: string;
}

export interface ShellCockpitAdoptionDecisionItem extends ShellCockpitDecisionBase {
  readonly kind: "adoption";
  readonly patchRef: string;
  readonly detail: string;
}

export interface ShellCockpitRecoveryAnchorOption {
  readonly anchorRef: string;
  readonly label: string;
  readonly turn: number;
  readonly effectsToRollbackCount: number;
  readonly lastTrustedReceiptRef: string | null;
}

export interface ShellCockpitRecoveryConfirmDecisionItem extends ShellCockpitDecisionBase {
  readonly kind: "recovery_confirm";
  readonly anchorOptions: readonly ShellCockpitRecoveryAnchorOption[];
  readonly lastTrustedReceiptRef: string | null;
  readonly effectsToRollbackCount: number;
  readonly detail: string;
}

export interface ShellCockpitManualGateDecisionItem extends ShellCockpitDecisionBase {
  readonly kind: "manual_gate";
  readonly detail: string;
}

export type ShellCockpitDecisionItem =
  | ShellCockpitApprovalDecisionItem
  | ShellCockpitQuestionDecisionItem
  | ShellCockpitCostGateDecisionItem
  | ShellCockpitAdoptionDecisionItem
  | ShellCockpitRecoveryConfirmDecisionItem
  | ShellCockpitManualGateDecisionItem;

// Read-only cockpit summary; approval and question interactions are owned by operator overlays.
export interface ShellCockpitDecisionLane {
  readonly active?: ShellCockpitDecisionItem;
  readonly queued: readonly ShellCockpitDecisionItem[];
  readonly overflowCount: number;
}

export type ShellCockpitLedgerKind =
  | "failed_tool"
  | "active_tool"
  | "effect_receipt"
  | "answer"
  | "ordinary_receipt_summary";

export type ShellCockpitConsequenceCategory =
  | "failed_effect"
  | "failed_observation"
  | "active_effect"
  | "active_observation"
  | "effect_receipt"
  | "answer"
  | "ordinary_receipt"
  | "unknown_receipt";

export interface ShellCockpitEffectLedgerItem {
  readonly kind: ShellCockpitLedgerKind;
  readonly consequence: ShellCockpitConsequenceCategory;
  readonly ref: string;
  readonly title: string;
  readonly status: "active" | "failed" | "committed" | "summarized";
  readonly verdict: "running" | "failed" | "committed" | "summarized";
  readonly actionClass?: ToolActionClass;
  readonly summary: string;
  readonly content?: string;
  readonly durationText?: string;
  readonly expandable: boolean;
  readonly rollbackRef?: string;
  readonly sourceRef: string;
  readonly stateChangedAt: number;
  readonly freshness: CockpitFreshness;
  readonly pinned: boolean;
  readonly receiptCount?: number;
  readonly archiveRefs: readonly string[];
}

export interface ShellCockpitEffectLedger {
  readonly items: readonly ShellCockpitEffectLedgerItem[];
  readonly collapsedReceiptCount: number;
  readonly overflowCount: number;
}

export type ShellCockpitRuntimeActivityStatus =
  | "idle"
  | "waiting_provider"
  | "streaming_answer"
  | "running_tool"
  | "waiting_approval"
  | "recovering"
  | "crashed"
  | "closed";

export interface ShellCockpitRuntimeActivity {
  readonly status: ShellCockpitRuntimeActivityStatus;
  readonly turnId: string | null;
  readonly attemptId: string | null;
  readonly startedAt: number | null;
  readonly lastProgressAt: number | null;
  readonly lastProgressRef: string | null;
  readonly promptPreview: string | null;
  readonly thinkingPreview: string | null;
  readonly progressLabel: string;
  readonly streamedChars: number;
  readonly providerBuffered: boolean;
}

export interface ShellCockpitCurrentWorkCard {
  readonly source: "task_work_card_projection";
  readonly ref: string;
  readonly freshness: CockpitFreshness;
  readonly pinned: boolean;
  readonly summary: {
    readonly goal: string | null;
    readonly phase: string | null;
    readonly health: string | null;
    readonly contextPressure: TaskWorkCardProjection["context"]["pressure"];
    readonly workbenchEntryCount: number;
    readonly activeRunCount: number;
    readonly pendingAskCount: number;
    readonly verificationOutcome: string | null;
    readonly verificationDebtCount: number;
    readonly missingChecks: readonly string[];
    readonly missingEvidence: readonly string[];
    readonly refs: readonly string[];
  };
  readonly archiveRefs: readonly string[];
}

export interface ShellCockpitAttentionGlance {
  readonly activeWorkbenchCount: number;
  readonly tokenEstimate: number | null;
  readonly workbenchPinnedRefs: readonly string[];
  readonly workbenchConsumedRefs: readonly string[];
  readonly evictedRefs: readonly string[];
  readonly staleRefs: readonly string[];
  readonly recallRefs: readonly string[];
  readonly compactBaselineRef: string | null;
  readonly runway: {
    readonly turnsUntilHighPressure: number | null;
    readonly burnRateTokensPerTurn: number | null;
  };
}

export interface ShellCockpitRecoveryLane {
  readonly active: boolean;
  readonly anchorRef: string | null;
  readonly targetCount: number;
  readonly lastTrustedReceiptRef: string | null;
  readonly anchorOptions: readonly ShellCockpitRecoveryAnchorOption[];
}

export interface ShellCockpitChannelProjection {
  readonly kind: "cli" | "telegram" | "runtime" | "unknown";
  readonly id: string;
  readonly label: string;
  readonly status: "active" | "idle" | "blocked" | "unknown";
  readonly sessionId?: string;
}

export interface ShellCockpitPhaseTransition {
  readonly from: SessionPhase["kind"] | "unknown";
  readonly to: SessionPhase["kind"] | "unknown";
  readonly sourceRef: string;
  readonly changedAt: number;
}

export interface ShellCockpitProjection {
  readonly schema: typeof SHELL_COCKPIT_PROJECTION_SCHEMA_V1;
  readonly version: 1;
  readonly sessionId: string;
  readonly generatedAtRef: string;
  readonly surfaceRegions: readonly ShellCockpitSurfaceRegion[];
  readonly observation: CockpitObservationCursor;
  readonly physicsBar: ShellCockpitPhysicsBar;
  readonly runtimeActivity: ShellCockpitRuntimeActivity;
  readonly currentWorkCard: ShellCockpitCurrentWorkCard;
  readonly decisionLane: ShellCockpitDecisionLane;
  readonly effectLedger: ShellCockpitEffectLedger;
  readonly attentionGlance: ShellCockpitAttentionGlance;
  readonly recoveryLane: ShellCockpitRecoveryLane;
  readonly channels: readonly ShellCockpitChannelProjection[];
  readonly transitionsSince: readonly ShellCockpitPhaseTransition[];
  readonly composerPolicy: ShellCockpitComposerPolicy;
  readonly archiveRefs: readonly CockpitArchiveRef[];
}

export interface ShellCockpitProjectionSource {
  readonly sessionId: string;
  readonly phase: SessionPhase;
  readonly workCard: TaskWorkCardProjection;
  readonly contextCockpit: ContextCockpitReport;
  readonly operator: OperatorSurfaceSnapshot;
  readonly sessionWire: readonly SessionWireFrame[];
  readonly runtimeEvents: readonly BrewvaEventRecord[];
  readonly cost: RuntimeCostPosture;
  readonly rewindTargets: readonly SessionRewindTargetView[];
  readonly observation: CockpitObservationCursor;
  readonly runtimeLabels?: {
    readonly providerLabel: string | null;
    readonly modelLabel: string | null;
    readonly sandboxPosture: ShellCockpitSandboxPosture;
  };
  readonly channels?: readonly ShellCockpitChannelProjection[];
  readonly transitionsSince?: readonly ShellCockpitPhaseTransition[];
}

export function cloneCockpitObservationCursor(
  observation: CockpitObservationCursor,
): CockpitObservationCursor {
  return {
    lastObservedAtRef: observation.lastObservedAtRef,
    focusedRef: observation.focusedRef,
    operatorPinnedRefs: [...observation.operatorPinnedRefs],
  };
}

export function shareShellCockpitProjection(
  projection: ShellCockpitProjection,
): ShellCockpitProjection {
  return projection;
}
