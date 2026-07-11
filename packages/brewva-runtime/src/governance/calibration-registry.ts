/**
 * The calibration parameter registry — the declarative, code-owned list of the
 * behavior constants that are CALIBRATION-ELIGIBLE: a human may retune them, as
 * reviewed code, when a receipt or report grades them.
 *
 * It grants NO authority and auto-tunes nothing (axiom 18; the
 * advisory-receipt-and-calibration-standard decision). It adds legibility as the
 * CALIBRATION membership fence: it names WHICH behavior constants a human may
 * retune in source when evidence grades them; every constant NOT listed stays
 * frozen by default.
 *
 * This is a DIFFERENT axis from the harness candidate MATERIALIZATION surface
 * (`materialize.ts` `classifyField`, today exactly `provider.model`) — that seam
 * is the per-run execution override an A/B trial applies, not a behavior constant
 * a human recalibrates over time. The two do not overlap today: every registry
 * parameter is calibration-eligible but NON-materializable (no harness seam maps
 * to it), and `provider.model` is materializable but not a calibration constant.
 * So "candidate-tunable" here means calibration-eligible, never "materializable
 * by the harness candidate executor"; there are not two competing tunable lists.
 *
 * It fences the NAMES, not admissible ranges: there is no per-parameter bound,
 * and `evidenceSource` is prose, not a runnable grader. Bounding each parameter's
 * domain and resolving `evidenceSource` to a check are the extension a future
 * optimizer would need before it could "propose within the fence"; naming the
 * membership now is what keeps that later phase reviewable instead of open-ended.
 *
 * `value` is a literal mirror of the live source. Every one of the 12 sources is
 * a NAMED constant (a config key or an exported const), so the parity fitness
 * (`test/fitness/calibration-registry.fitness.test.ts`) import-checks ALL of them
 * against their live source — the registry cannot silently drift, and a new entry
 * that adds an unguarded mirror fails the fitness. The calibration-report cycle
 * renders this module as a view via `bun run analyze:calibration-registry`.
 *
 * `asserted` is the honest default: an unexercised threshold cannot be retuned
 * from a corpus that has never fired it (the calibration standard's residue).
 */

export type CalibrationStatus = "asserted" | "calibrated" | "contested";

export interface CalibrationParameter {
  /**
   * Config key path (dotted) or a named-constant reference — a slash-joined pair
   * for a two-cutoff scale. Always resolves to a real key/symbol (the parity
   * fitness uses it as the join key), never prose.
   */
  readonly path: string;
  /** Literal mirror of the current value; parity-checked against `source`. */
  readonly value: number | readonly number[];
  /** The file (and symbol) where the live value is defined. */
  readonly source: string;
  /** Which receipt or report can grade this parameter offline. */
  readonly evidenceSource: string;
  /**
   * `asserted` = an unexercised default (the honest starting point);
   * `calibrated` = graded against a named corpus; `contested` = a recorded
   * parameter-honesty debt.
   */
  readonly status: CalibrationStatus;
  /** A deliberate-divergence justification, a grading corpus, or a debt note. */
  readonly note?: string;
}

export const CALIBRATION_PARAMETER_REGISTRY: readonly CalibrationParameter[] = [
  {
    path: "infrastructure.contextBudget.thresholds.advisoryRatio",
    value: 0.82,
    source:
      "packages/brewva-runtime/src/config/defaults.ts — contextBudget.thresholds.advisoryRatio",
    evidenceSource: "compaction economics verdicts (report:context-evidence netReuseValue/grade)",
    status: "asserted",
    note: "The canonical compaction-trigger ratio (successor of the removed contextBudget.compactionThresholdPercent; see config/field-policy.ts). The dead test-only DEFAULT_COMPACTION_THRESHOLD_RATIO=0.80 duplicate was removed in Phase 3.",
  },
  {
    path: "infrastructure.contextBudget.thresholds.hardRatio",
    value: 0.94,
    source: "packages/brewva-runtime/src/config/defaults.ts — contextBudget.thresholds.hardRatio",
    evidenceSource: "compaction economics verdicts (report:context-evidence)",
    status: "asserted",
  },
  {
    path: "infrastructure.contextBudget.predictedTurnGrowthRatio",
    value: 0.175,
    source:
      "packages/brewva-runtime/src/config/defaults.ts — contextBudget.predictedTurnGrowthRatio",
    evidenceSource: "report:context-evidence (predicted vs actual next-turn token growth)",
    status: "asserted",
  },
  {
    path: "infrastructure.contextBudget.compaction.tailProtectRatio",
    value: 0.2,
    source:
      "packages/brewva-runtime/src/config/defaults.ts — contextBudget.compaction.tailProtectRatio",
    evidenceSource: "compaction economics verdicts (report:context-evidence)",
    status: "asserted",
  },
  {
    path: "infrastructure.contextBudget.dynamicTailTokens",
    value: 4800,
    source: "packages/brewva-runtime/src/config/defaults.ts — contextBudget.dynamicTailTokens",
    evidenceSource: "report:context-evidence (dynamic tail injection cost)",
    status: "asserted",
  },
  {
    path: "RECALL_TAPE_FRESH_MAX_DAYS / RECALL_TAPE_AGING_MAX_DAYS",
    value: [30, 180],
    source:
      "packages/brewva-recall/src/broker/text.ts — RECALL_TAPE_FRESH_MAX_DAYS/RECALL_TAPE_AGING_MAX_DAYS",
    evidenceSource: "recall receipts / eval:recall (useful vs stale tape hits)",
    status: "asserted",
    note: "Deliberately DIFFERENT from the knowledge-doc scale [90, 365]: this grades a session tape/memory entry (epoch-ms), which ages in weeks; the knowledge scale grades normative markdown docs, which stay current for months. Two independently chosen scales over two corpora, not one number drifted — the divergence is earned, not a debt to converge.",
  },
  {
    path: "KNOWLEDGE_FRESH_MAX_DAYS / KNOWLEDGE_AGING_MAX_DAYS",
    value: [90, 365],
    source:
      "packages/brewva-recall/src/knowledge/search.ts — KNOWLEDGE_FRESH_MAX_DAYS/KNOWLEDGE_AGING_MAX_DAYS",
    evidenceSource: "knowledge search receipts",
    status: "asserted",
    note: "Deliberately DIFFERENT from the tape scale [30, 180]: grades a normative knowledge doc (frontmatter date), which stays current far longer than a session memory. See the tape entry above.",
  },
  {
    path: "RECALL_CURATION_HALFLIFE_DAYS",
    value: 45,
    source: "packages/brewva-recall/src/types.ts — RECALL_CURATION_HALFLIFE_DAYS",
    evidenceSource: "recall curation receipts (helpful/stale/superseded signal decay)",
    status: "asserted",
  },
  {
    path: "distiller MIN_COMPRESSION_GAIN",
    value: 0.1,
    source:
      "packages/brewva-gateway/src/hosted/internal/session/tools/tool-output-distiller.ts — MIN_COMPRESSION_GAIN",
    evidenceSource: "tool_output_distilled receipts (analyze:advisory-receipts distiller view)",
    status: "asserted",
    note: "Distillation is discarded unless it saves at least this fraction of tokens.",
  },
  {
    path: "FAILURE_RECURRENCE_THRESHOLD",
    value: 2,
    source:
      "packages/brewva-gateway/src/hosted/internal/context/failure-recurrence.ts — FAILURE_RECURRENCE_THRESHOLD",
    evidenceSource: "committed err/aborted receipts (RuntimeBrief failure-recurrence section)",
    status: "asserted",
  },
  {
    path: "read-path-recovery MIN_CONSECUTIVE_MISSING_PATH_FAILURES",
    value: 2,
    source:
      "packages/brewva-gateway/src/hosted/internal/context/read-path-recovery.ts — MIN_CONSECUTIVE_MISSING_PATH_FAILURES",
    evidenceSource: "read-path recovery evidence receipts",
    status: "asserted",
    note: "Arms the recovery evidence block on this many consecutive missing-path failures.",
  },
  {
    path: "STALL_RECENT_TOOL_FAILURES_THRESHOLD",
    value: 3,
    source:
      "packages/brewva-gateway/src/hosted/internal/session/watchdog/task-stall-adjudication.ts — STALL_RECENT_TOOL_FAILURES_THRESHOLD",
    evidenceSource: "task.stall.adjudicated receipts (analyze:advisory-receipts stall view)",
    status: "asserted",
    note: "A conservative advisory circuit-breaker, acceptable until receipts accumulate enough to grade it.",
  },
];
