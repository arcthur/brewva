import type { FitnessDiscrepancyGrade } from "./fitness.js";
import type { IndependenceBasis, VerificationPerspective } from "./review.js";
import type { ProtocolRecord } from "./types/foundation.js";

// Work Card projection domain, carved out of internal/session.ts when Task 6's
// evidence fields (perspective/basis/reviewDebt) pushed that module past the
// 800-line internal budget — the sanctioned split-over-bump convention. The
// public import path (@brewva/brewva-vocabulary/session) is unchanged: the
// session entry module sources these names from here.

export const TASK_WORK_CARD_PROJECTION_SCHEMA_V2 = "brewva.task-work-card.projection.v2" as const;

export type TaskWorkCardContextPressure = "low" | "medium" | "high" | "forced" | "unknown";

export interface TaskWorkCardProjection extends ProtocolRecord {
  readonly schema: typeof TASK_WORK_CARD_PROJECTION_SCHEMA_V2;
  readonly version: 2;
  readonly sessionId: string;
  readonly refs: readonly string[];
  readonly goal: {
    readonly current: string | null;
    readonly phase: string | null;
    readonly health: string | null;
    readonly targetRoots: readonly string[];
    readonly taskItemCount: number;
    readonly blockerCount: number;
  };
  readonly persistentGoal?: {
    readonly objective: string | null;
    readonly status: string | null;
    readonly tokenBudget: number | null;
    readonly tokensUsed: number;
    readonly elapsedMs: number;
    readonly lastLifecycleEvent: string | null;
    readonly latestContinuationRef: string | null;
    readonly latestCompletionEvidenceRef: string | null;
    readonly latestBlockEvidenceRef: string | null;
  };
  readonly context: {
    readonly pressure: TaskWorkCardContextPressure;
    readonly workbenchEntryCount: number;
    readonly skillInvocationRefs: readonly string[];
    readonly resourceRefs: readonly string[];
    readonly recallResultRefs: readonly string[];
    readonly compactBaselineRef: string | null;
    readonly automaticallyAvailableRefs: readonly string[];
  };
  readonly options: {
    readonly generatedCount: number;
    readonly consumedRefs: readonly string[];
    readonly pinnedRefs: readonly string[];
    readonly ignoredRefs: readonly string[];
    readonly verifyPlanRefs: readonly string[];
  };
  readonly authority: {
    readonly selectedCapabilities: readonly string[];
    readonly capabilityReceiptRefs: readonly string[];
    readonly pendingAskCount: number;
    readonly denialCount: number;
    readonly recentDecisionRefs: readonly string[];
  };
  readonly work: {
    readonly activeRunCount: number;
    readonly pendingWorkerPatchCount: number;
    readonly pendingKnowledgeAdoptionCount: number;
    readonly unreadEvidenceCount: number;
    readonly blockedOrFailedRunCount: number;
    readonly recoveryNextOwner: string;
  };
  readonly evidence: {
    readonly verificationOutcome: string | null;
    readonly verificationLevel: string | null;
    readonly failedChecks: readonly string[];
    readonly missingChecks: readonly string[];
    readonly missingEvidence: readonly string[];
    readonly verificationDebtCount: number;
    readonly latestPatchSetRef: string | null;
    /** Perspective of the latest verification receipt (`authored` when none exists yet). */
    readonly verificationPerspective: VerificationPerspective;
    /** Independence basis of the latest verification receipt, `[]` when authored or absent. */
    readonly independenceBasis: readonly IndependenceBasis[];
    /**
     * Tape-only review debt (`projectTapeReviewDebt`, the conservative match
     * rule shared with run-report): the latest receipt is a `pass` at
     * `requirements`+ on fresh code with no independent receipt whose
     * `targetRef` still matches. Never reads the filesystem.
     */
    readonly reviewDebt: boolean;
    /**
     * The latest verification receipt's fitness annotation, tallied by the
     * SAME `readReceiptFitnessSummary` helper `inspect run-report`'s Fitness
     * section calls — one shared computation, never forked. Carries ONLY what
     * the receipt legitimately owns (violated via discrepancies,
     * unverifiedMust): no satisfied/likelySatisfied/notApplicable counts,
     * which are re-derivable `projectRequirementFitness` output, not
     * receipt-committed fact (W3 wave review's binding ruling). All-zero
     * (never omitted) when no receipt exists or the latest one carries no
     * annotation.
     */
    readonly fitness: {
      readonly violated: number;
      readonly unverifiedMust: number;
      readonly discrepanciesByGrade: Readonly<Record<FitnessDiscrepancyGrade, number>>;
    };
  };
  readonly continuationAnchor: {
    readonly anchorId: string | null;
    readonly name: string | null;
    readonly summary: string | null;
    readonly nextSteps: string | null;
  };
}
