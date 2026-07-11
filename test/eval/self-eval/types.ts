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
 * run's FINAL workspace. `command` (build/debug): run it in the workspace, exit 0
 * = passed (the fixture's own test). `readonly_unchanged` (comprehension): every
 * listed file must be byte-identical to what was staged — the do-not-modify
 * constraint the task declares. The oracle never runs a provider and is
 * deterministic given the workspace, so it is unit-testable over staged
 * good/bad workspaces. (Comprehension summary QUALITY beyond the constraint is
 * not oracle-checked — a documented limit; the build/debug command oracles carry
 * the real task-success signal.)
 */
export type SelfEvalOracle =
  | { readonly kind: "command"; readonly command: readonly string[] }
  | { readonly kind: "readonly_unchanged"; readonly paths: readonly string[] };

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

/** The three task shapes the n=12 recipe exercised. */
export type SelfEvalTaskKind = "build" | "debug" | "comprehension";

/**
 * One frozen self-eval task (an evaluator definition, D6). Fixtures are DATA,
 * not the optimizable code allowlist, so a harness candidate can never retune
 * the yardstick it is graded against.
 */
export interface SelfEvalFixture {
  readonly id: string;
  readonly kind: SelfEvalTaskKind;
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
  readonly kind: SelfEvalTaskKind;
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
  readonly schema: "brewva.self-eval.report.v1";
  readonly generatedAt: string;
  readonly model: string;
  readonly runsPerFixture: number;
  readonly runs: readonly SelfEvalRunResult[];
  readonly aggregate: SelfEvalAggregate;
}
