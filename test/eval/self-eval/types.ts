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
 * How a run ended, read from its tape tail. Only two outcomes are asserted, both
 * from fidelity-verified tape causes: `completed` (turn.ended terminal_commit)
 * and `suspended_for_approval` (an unresolved runtime.suspended approval_pending
 * — the Phase-1 fail-closed signal, the RFC's "still suspends the moment it
 * proposes an uncovered effect class"). `incomplete` is any other terminal-ish
 * event (no clean completion observed); `unknown` is no terminal signal at all.
 */
export type SelfEvalTerminalOutcome =
  | "completed"
  | "suspended_for_approval"
  | "incomplete"
  | "unknown";

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
   * Files staged into the hermetic workspace before the run, keyed by
   * workspace-relative path. MUST include the `.brewva/brewva.json` config
   * carrying `security.unattendedApproval` so exec-needing tasks finish
   * unattended (the Phase-1 chain); the driver rejects a fixture without it.
   */
  readonly workspaceFiles: Readonly<Record<string, string>>;
}

export interface SelfEvalRunResult {
  readonly fixtureId: string;
  readonly kind: SelfEvalTaskKind;
  readonly metrics: SelfEvalRunMetrics;
  /** The print run's exit code — a diagnostic; the tape-derived outcome is truth. */
  readonly exitCode: number | null;
  /** False when the run produced no durable tape (recorded, never scored as success). */
  readonly tapePresent: boolean;
  /** The kept hermetic workspace, retained for inspection. */
  readonly workspace: string;
}

/** Corpus-level roll-up over a self-eval report's runs. */
export interface SelfEvalAggregate {
  readonly fixtureCount: number;
  readonly runCount: number;
  readonly completedRuns: number;
  /** Runs that fail-closed suspended on an uncovered effect class. */
  readonly suspendedRuns: number;
  readonly incompleteRuns: number;
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
