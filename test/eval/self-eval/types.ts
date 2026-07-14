/**
 * Minimal structural projection of a tape event the frozen evaluator scores
 * over. Structurally satisfied by `BrewvaEventRecord`, the `committedToolEvent`
 * test helper, and `parseCanonicalTapeOperationalEvents` output alike, so the
 * extractor is decoupled from any single tape reader.
 */
export interface SelfEvalTapeEvent {
  readonly type?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * TURN LIVENESS, read from the tape tail — how the turn ENDED, not whether the
 * task succeeded. Fidelity-verified tape causes: `completed` (turn.ended
 * terminal_commit), `suspended_for_approval` (an unresolved runtime.suspended
 * approval_pending — the Phase-1 fail-closed signal), `incomplete` (any other
 * terminal-ish event, no clean completion observed), `unknown` (no terminal
 * signal at all). A `completed` turn only means the model stopped cleanly; task
 * success is a SEPARATE question the post-run oracle answers ({@link
 * SelfEvalTaskOutcome}).
 */
export type SelfEvalTerminalOutcome =
  | "completed"
  | "suspended_for_approval"
  | "incomplete"
  | "unknown";

/**
 * TASK SUCCESS, from a per-fixture post-run ORACLE over the final workspace — the
 * utility signal turn liveness cannot give. `task_passed` / `task_failed` come
 * from the oracle (a build/debug fixture's test command exiting 0, or a
 * comprehension fixture's do-not-modify constraint holding) and are decided ONLY
 * when the turn reached `completed` liveness. `terminal_incomplete` is every run
 * whose turn did not cleanly complete (suspended / incomplete / timed out /
 * unknown) — there the oracle is not run, because task success is undefined on a
 * run that never finished. This is what separates "the model stopped" from "the
 * task is actually done": a model that ends its turn without fixing the bug, with
 * a wrong fix, or claiming success it did not achieve scores `task_failed`, not
 * `completed`.
 */
export type SelfEvalTaskOutcome = "task_passed" | "task_failed" | "terminal_incomplete";

/**
 * A per-fixture post-run oracle: the deterministic check of task success over the
 * run's FINAL workspace. A `command` oracle stages only declared subject files
 * plus fixture-owned verifier files into a fresh directory AFTER the model exits;
 * it never runs a model-writable test. `architecture_response` checks both the
 * untouched source contract and a machine-readable final answer from the durable
 * tape. `readonly_unchanged` remains available for narrow constraint-only checks,
 * but is not a task-success oracle for the comprehension fixture.
 */
export interface SelfEvalCommandOracleFields {
  readonly command: readonly string[];
  /** Final model-produced files copied into the isolated verifier. */
  readonly subjectFiles: readonly string[];
  /** Frozen test inputs written only after the model process has exited. */
  readonly verifierFiles: Readonly<Record<string, string>>;
}

export type SelfEvalOracle =
  | ({ readonly kind: "command" } & SelfEvalCommandOracleFields)
  | ({
      readonly kind: "command_with_exception_evidence";
      readonly receiptFile: string;
      readonly expectedRuleId: string;
      readonly requiredEvidence: readonly string[];
      readonly allowedEvidence: readonly string[];
    } & SelfEvalCommandOracleFields)
  | { readonly kind: "readonly_unchanged"; readonly paths: readonly string[] }
  | {
      readonly kind: "architecture_response";
      readonly readonlyPaths: readonly string[];
      readonly modules: readonly SelfEvalArchitectureModuleExpectation[];
    }
  | {
      readonly kind: "review_response";
      readonly readonlyPaths: readonly string[];
      /** Every seeded defect the review must surface to pass. */
      readonly requiredFindings: readonly SelfEvalReviewFindingExpectation[];
      /** The merge decision a correct review of the seeded target must reach. */
      readonly expectedMergeDecision: "ready" | "blocked";
    };

export interface SelfEvalArchitectureModuleExpectation {
  readonly path: string;
  readonly dependsOn: readonly string[];
  readonly responsibilityTerms: readonly string[];
}

/**
 * One seeded defect a review-fixture response must surface: a finding whose
 * `path` equals the seeded file and whose issue text mentions at least one of
 * the expected terms (case-insensitive). Terms are deliberately generous — a
 * genuine description of the defect lands on one of them; the oracle grades
 * detection, not phrasing.
 */
export interface SelfEvalReviewFindingExpectation {
  readonly path: string;
  /** Every group must contribute at least one term to the same finding. */
  readonly termGroups: readonly (readonly string[])[];
}

/**
 * Non-structural per-run cost — an OBSERVATION sourced from the run's own
 * reported cost summary (the print protocol's authoritative per-run cost), not
 * from the tape and not asserted stable across runs. Absent when the run
 * reports none; it never participates in the repeatability gate.
 */
export interface SelfEvalCostObservation {
  readonly totalTokens?: number;
  readonly totalCostUsd?: number;
}

/**
 * Per-run metrics. The structural fields (`distinctTools`..`terminalOutcome`)
 * are derived purely and deterministically from the run's committed tape — that
 * determinism is the repeatability gate. `cost` carries its own provenance and
 * never gates repeatability.
 */
export interface SelfEvalRunMetrics {
  readonly distinctTools: readonly string[];
  readonly distinctToolCount: number;
  readonly perFamilyCounts: Readonly<Record<string, number>>;
  readonly toolCallCount: number;
  readonly turnCount: number;
  readonly terminalOutcome: SelfEvalTerminalOutcome;
  readonly cost?: SelfEvalCostObservation;
}

/**
 * The task shapes under evaluation: `build`, `debug`, and `comprehension` (the
 * three the tool-surface measurement corpus exercised), plus `review` (pilot
 * fixtures for the skill-discipline-calibration gate — a read-only adversarial
 * read scored on seeded-defect detection).
 */
export type SelfEvalTaskKind = "build" | "debug" | "comprehension" | "review";

export type SelfEvalSkillArm = "no_skill" | "kernel_only" | "kernel_scaffold";
export type SelfEvalPilotSkill = "debugging" | "learning-research" | "review";
export type SelfEvalModelTier = "strong" | "weak";
export type SelfEvalGateClass = "utility" | "safety_honesty";
export type SelfEvalEvaluationMode = "retirement" | "diagnostic";

export interface SelfEvalSkillIdentity {
  readonly name: string;
  readonly contentDigest: string;
}

export interface SelfEvalSkillContext {
  readonly arm: SelfEvalSkillArm;
  readonly skillCorpusDigest: string;
  readonly loadedSkills: readonly SelfEvalSkillIdentity[];
}

/**
 * One frozen self-eval task (an evaluator definition, D6). Fixtures are DATA,
 * not the optimizable code allowlist, so a harness candidate can never retune
 * the yardstick it is graded against.
 */
export interface SelfEvalFixture {
  readonly id: string;
  readonly kind: SelfEvalTaskKind;
  /** Pilot whose treatment this fixture is designed to exercise, when any. */
  readonly targetPilotSkill?: SelfEvalPilotSkill;
  /** Safety/honesty regressions are never absorbed by the utility margin. */
  readonly gateClass: SelfEvalGateClass;
  /** One-line human summary of what the task exercises. */
  readonly description: string;
  /** The task prompt handed verbatim to the print turn. */
  readonly prompt: string;
  /**
   * Task files staged into the hermetic workspace before the run, keyed by
   * workspace-relative path. This carries ONLY task inputs — never the approval
   * policy, which the driver delivers from OUTSIDE the workspace so a model with
   * workspace-write cannot mutate the envelope it runs under (the operator-source
   * barrier).
   */
  readonly workspaceFiles: Readonly<Record<string, string>>;
  /**
   * The operator-declared unattended approval envelope for this run. The driver
   * writes it to a config OUTSIDE the model-writable workspace and passes it via
   * `--config`, so it is honored by the loader's operator-source barrier (a
   * workspace-internal policy would be stripped as model-writable). This is the
   * Phase-1 chain, now delivered as launch authority rather than workspace data.
   */
  readonly operatorApprovalPolicy: Readonly<Record<string, "allow" | "deny">>;
  /** Post-run success check over the final workspace ({@link SelfEvalOracle}). */
  readonly oracle: SelfEvalOracle;
}

export interface SelfEvalRunResult {
  readonly fixtureId: string;
  /** Stable ordinal within the fixture, used as the paired-run identity. */
  readonly runIndex: number;
  readonly kind: SelfEvalTaskKind;
  readonly gateClass: SelfEvalGateClass;
  /** Every route that produced usage, derived from durable cost receipts. */
  readonly observedModelRoutes: readonly string[];
  /** Receipt-backed proof that a target-relevant treatment was actually consumed. */
  readonly treatmentExposure: {
    readonly targetRelevant: boolean;
    readonly targetSkillOffered: boolean;
    readonly targetSkillOpened: boolean;
    readonly strictScaffoldOpened: boolean;
  };
  /** Exact skill corpus staged where the production catalog reads it. */
  readonly skillContext: SelfEvalSkillContext;
  readonly metrics: SelfEvalRunMetrics;
  /**
   * Task success from the post-run oracle — the utility signal. Distinct from
   * `metrics.terminalOutcome` (turn liveness): a `completed` turn can still be
   * `task_failed`.
   */
  readonly taskOutcome: SelfEvalTaskOutcome;
  /** The print run's exit code — a diagnostic; the tape + oracle are truth. */
  readonly exitCode: number | null;
  /** True when the run hit the driver's hard deadline (a distinct, visible outcome). */
  readonly timedOut: boolean;
  /** False when the run produced no durable tape (recorded, never scored as success). */
  readonly tapePresent: boolean;
  /** The kept hermetic workspace, retained for inspection. */
  readonly workspace: string;
}

/**
 * Corpus-level roll-up. Two orthogonal tallies, each summing to `runCount`: the
 * TASK-SUCCESS headline (from the oracle) and the TURN-LIVENESS breakdown
 * (diagnostic). Every run lands in exactly one bucket of each — no run is
 * silently dropped.
 */
export interface SelfEvalAggregate {
  readonly fixtureCount: number;
  readonly runCount: number;
  // Task-success headline (oracle): taskPassed + taskFailed + terminalIncomplete === runCount.
  readonly taskPassedRuns: number;
  readonly taskFailedRuns: number;
  readonly terminalIncompleteRuns: number;
  // Turn-liveness breakdown (tape + timeout): the five sum to runCount.
  readonly completedRuns: number;
  /** Runs that fail-closed suspended on an uncovered effect class. */
  readonly suspendedRuns: number;
  readonly incompleteRuns: number;
  /** Runs killed by the driver's hard deadline. */
  readonly timedOutRuns: number;
  /** Runs with no readable terminal tape signal. */
  readonly unknownRuns: number;
  /** Union of committed tool names across every run (the exercised surface). */
  readonly distinctToolsUnion: readonly string[];
  /** Per-family committed counts summed across every run. */
  readonly perFamilyCounts: Readonly<Record<string, number>>;
  readonly cost?: SelfEvalCostObservation;
}

/**
 * The dated self-eval report the calibration cycle ingests. Structural fields
 * are deterministic given the runs; `generatedAt` is supplied by the caller
 * (never read from a clock inside the builder) so the builder stays pure.
 */
export interface SelfEvalReport {
  /** v4 adds per-skill/tier/evaluator identity and complete per-run route sets. */
  readonly schema: "brewva.self-eval.report.v4";
  readonly generatedAt: string;
  readonly requestedModel: string;
  readonly observedModelRoutes: readonly string[];
  readonly runsPerFixture: number;
  readonly experiment: {
    readonly id: string;
    /** Only retirement reports may participate in a demotion decision. */
    readonly evaluationMode: SelfEvalEvaluationMode;
    readonly arm: SelfEvalSkillArm;
    readonly pilotSkill: SelfEvalPilotSkill;
    readonly modelTier: SelfEvalModelTier;
    readonly sourceRevision: string;
    readonly evaluatorCorpusDigest: string;
    readonly fixtureCorpusDigest: string;
    readonly skillCorpusDigest: string;
    readonly loadedSkills: readonly SelfEvalSkillIdentity[];
  };
  readonly runs: readonly SelfEvalRunResult[];
  readonly aggregate: SelfEvalAggregate;
}
