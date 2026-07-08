import {
  projectSessionDelegationState,
  type SessionIndexDelegationRun,
} from "@brewva/brewva-session-index";
import { isRecord } from "@brewva/brewva-std/unknown";
import { buildTapeRequirementFitness } from "@brewva/brewva-tools/runtime-port";
import {
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_SLOT_REJECTED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
  WORKER_RESULTS_REJECTED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import { listRuntimeEvents, listRuntimeEventSessionIds } from "../../session/runtime-ports.js";

/**
 * Lever 6 of the delegation-activation RFC: the empirical instrument that grades
 * the wording levers (1–3). It measures delegation TRIGGER economics — reach,
 * outcome, and cost — deterministically from the tape, so a before/after against
 * a doctrine change is a fact, not a hunch. The report auto-applies nothing and
 * follows the shared-projection discipline (explicit-pull, rebuildable from
 * receipts). It reads the same session-index delegation projection the inspect
 * surfaces read, plus the raw rejection/failure/adoption events those roll up.
 *
 * The FAILURE block is the reliability counter-signal the review demanded: an
 * activation gain that arrives with a rising failure rate is the doctrine pushing
 * the model into a wall (the up5 dispatch failure), not adoption.
 *
 * Deferred by design: advisory-effectiveness (advisory renders vs delegations
 * started) waits on Lever 2's render events, and context economics reports raw
 * child totals only — the "vs parent-side injected outcome size" half needs an
 * injection-size receipt that does not exist yet. Both land when their producers do.
 */

type EvidenceRuntime = Parameters<typeof listRuntimeEvents>[0];

const DELEGATION_ROLES = ["navigator", "explorer", "worker", "verifier", "librarian"] as const;

export interface DelegationEvidenceReportOptions {
  readonly sessionIds?: readonly string[];
}

export interface DelegationCounts {
  readonly total: number;
  readonly byRole: Record<string, number>;
  readonly byPrimitive: Record<string, number>;
  readonly byStatus: Record<string, number>;
  readonly byWaitMode: Record<string, number>;
}

export interface ParallelRejectionCounts {
  readonly total: number;
  readonly byReason: Record<string, number>;
}

/** Reliability counter-signal (the review's addition): why a reach failed. */
export interface DelegationFailureCounts {
  /** Failure EVENTS across all runs — a run can raise more than one. */
  readonly total: number;
  /** `subagent_failed` — dispatch/spawn failure, the up5 model-routing mode. */
  readonly dispatch: number;
  /** `subagent_outcome_parse_failed` — the child ran but its result was unusable. */
  readonly consult: number;
  /** Distinct runs that raised any failure event — the numerator of a true rate. */
  readonly failedRuns: number;
}

export interface AdoptionOutcomeCounts {
  readonly applied: number;
  readonly applyFailed: number;
  readonly rejected: number;
}

export interface ContextEconomics {
  readonly childRunsWithTokens: number;
  readonly childTotalTokens: number;
}

/**
 * Independence-debt census carried into turn close — the discharge OUTCOME the
 * review→atom close-edge produced for the session's high-risk `must` atoms
 * (`FitnessProjection.independenceDebtResolution`, re-derived once at tape end):
 * - `open`: still owes an at-grade read. An `open` that never falls even as reviews
 *   run is the debt's irreducible tail (no at-grade producer can reach those atoms),
 *   the way a rising `failureRate` means activation hit a wall;
 * - `violated`: a live fail named it as a known break — a review/independent FAIL OR a
 *   deterministic static-guard fail (both reach `violated`);
 * - `dischargedAtGrade`: reached `satisfied` via an at-grade pass, independent OR
 *   deterministic (a presence-grade review CANNOT clear a high-risk atom — the grade
 *   ceiling).
 * A rising `violated` + `dischargedAtGrade` against a flat `open` means high-risk atoms
 * are reaching at-grade closure rather than being left owed; the review→atom fold is
 * ONE driver, not the sole one — read it as closure, not as a review-only signal.
 */
export interface IndependenceDebtCounts {
  readonly open: number;
  readonly violated: number;
  readonly dischargedAtGrade: number;
}

export interface DelegationEvidenceSessionReport {
  readonly sessionId: string;
  readonly counts: DelegationCounts;
  readonly parallelRejections: ParallelRejectionCounts;
  readonly failures: DelegationFailureCounts;
  readonly adoption: AdoptionOutcomeCounts;
  readonly contextEconomics: ContextEconomics;
  readonly independenceDebt: IndependenceDebtCounts;
}

export interface DelegationEvidenceAggregate {
  readonly sessionCount: number;
  readonly counts: DelegationCounts;
  readonly parallelRejections: ParallelRejectionCounts;
  readonly failures: DelegationFailureCounts;
  readonly adoption: AdoptionOutcomeCounts;
  readonly contextEconomics: ContextEconomics;
  readonly independenceDebt: IndependenceDebtCounts;
  /**
   * Distinct failed runs / runs started — a true [0,1] rate (a run can raise
   * several failure EVENTS, so this dedupes by run before dividing). The
   * counter-signal to any activation gain. Null with no runs.
   */
  readonly failureRate: number | null;
}

export interface DelegationEvidenceReport {
  readonly sessions: readonly DelegationEvidenceSessionReport[];
  readonly aggregate: DelegationEvidenceAggregate;
}

interface TapeEvent {
  readonly type: string;
  readonly payload?: unknown;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Child token usage from a run record, where the provider reported it. */
function runTotalTokens(record: Record<string, unknown>): number | null {
  const direct = readNumber(record.totalTokens);
  if (direct !== null) return direct;
  return isRecord(record.usage) ? readNumber(record.usage.totalTokens) : null;
}

/** How many worker RESULTS an adoption event carries (payload.workerIds), not events. */
function workerIdCount(event: TapeEvent): number {
  const ids = isRecord(event.payload) ? event.payload.workerIds : undefined;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string").length : 1;
}

function readRunField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "unknown";
}

function countDelegations(runs: readonly SessionIndexDelegationRun[]): DelegationCounts {
  const byRole: Record<string, number> = {};
  const byPrimitive: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byWaitMode: Record<string, number> = {};
  for (const run of runs) {
    const agent = run.agent ?? "";
    increment(byRole, (DELEGATION_ROLES as readonly string[]).includes(agent) ? agent : "other");
    increment(byPrimitive, readRunField(run.record, "executionPrimitive"));
    increment(byStatus, run.status);
    increment(byWaitMode, readRunField(run.record, "waitMode"));
  }
  return { total: runs.length, byRole, byPrimitive, byStatus, byWaitMode };
}

function countParallelRejections(events: readonly TapeEvent[]): ParallelRejectionCounts {
  const byReason: Record<string, number> = {};
  let total = 0;
  for (const event of events) {
    if (event.type !== SUBAGENT_SLOT_REJECTED_EVENT_TYPE) continue;
    total += 1;
    increment(byReason, (isRecord(event.payload) && readString(event.payload.reason)) || "unknown");
  }
  return { total, byReason };
}

function countFailures(events: readonly TapeEvent[]): DelegationFailureCounts {
  let dispatch = 0;
  let consult = 0;
  const failedRunIds = new Set<string>();
  for (const event of events) {
    const isDispatch = event.type === SUBAGENT_FAILED_EVENT_TYPE;
    const isConsult = event.type === SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE;
    if (!isDispatch && !isConsult) continue;
    if (isDispatch) dispatch += 1;
    else consult += 1;
    const runId = isRecord(event.payload) ? readString(event.payload.runId) : null;
    if (runId) failedRunIds.add(runId);
  }
  return { total: dispatch + consult, dispatch, consult, failedRuns: failedRunIds.size };
}

function countAdoption(events: readonly TapeEvent[]): AdoptionOutcomeCounts {
  let applied = 0;
  let applyFailed = 0;
  let rejected = 0;
  for (const event of events) {
    if (event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE) applied += workerIdCount(event);
    else if (event.type === WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE)
      applyFailed += workerIdCount(event);
    else if (event.type === WORKER_RESULTS_REJECTED_EVENT_TYPE) rejected += workerIdCount(event);
  }
  return { applied, applyFailed, rejected };
}

function measureContextEconomics(runs: readonly SessionIndexDelegationRun[]): ContextEconomics {
  let childRunsWithTokens = 0;
  let childTotalTokens = 0;
  for (const run of runs) {
    const tokens = runTotalTokens(run.record);
    if (tokens !== null) {
      childRunsWithTokens += 1;
      childTotalTokens += tokens;
    }
  }
  return { childRunsWithTokens, childTotalTokens };
}

function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, value] of Object.entries(from)) {
    into[key] = (into[key] ?? 0) + value;
  }
}

function aggregate(
  sessions: readonly DelegationEvidenceSessionReport[],
): DelegationEvidenceAggregate {
  const byRole: Record<string, number> = {};
  const byPrimitive: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byWaitMode: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let total = 0;
  let rejectionTotal = 0;
  let dispatch = 0;
  let consult = 0;
  let failedRuns = 0;
  let applied = 0;
  let applyFailed = 0;
  let rejected = 0;
  let childRunsWithTokens = 0;
  let childTotalTokens = 0;
  let independenceDebtOpen = 0;
  let independenceDebtViolated = 0;
  let independenceDebtDischargedAtGrade = 0;
  for (const session of sessions) {
    total += session.counts.total;
    mergeCounts(byRole, session.counts.byRole);
    mergeCounts(byPrimitive, session.counts.byPrimitive);
    mergeCounts(byStatus, session.counts.byStatus);
    mergeCounts(byWaitMode, session.counts.byWaitMode);
    rejectionTotal += session.parallelRejections.total;
    mergeCounts(byReason, session.parallelRejections.byReason);
    dispatch += session.failures.dispatch;
    consult += session.failures.consult;
    failedRuns += session.failures.failedRuns;
    applied += session.adoption.applied;
    applyFailed += session.adoption.applyFailed;
    rejected += session.adoption.rejected;
    childRunsWithTokens += session.contextEconomics.childRunsWithTokens;
    childTotalTokens += session.contextEconomics.childTotalTokens;
    independenceDebtOpen += session.independenceDebt.open;
    independenceDebtViolated += session.independenceDebt.violated;
    independenceDebtDischargedAtGrade += session.independenceDebt.dischargedAtGrade;
  }
  return {
    sessionCount: sessions.length,
    counts: { total, byRole, byPrimitive, byStatus, byWaitMode },
    parallelRejections: { total: rejectionTotal, byReason },
    failures: { total: dispatch + consult, dispatch, consult, failedRuns },
    adoption: { applied, applyFailed, rejected },
    contextEconomics: { childRunsWithTokens, childTotalTokens },
    independenceDebt: {
      open: independenceDebtOpen,
      violated: independenceDebtViolated,
      dischargedAtGrade: independenceDebtDischargedAtGrade,
    },
    failureRate: total > 0 ? failedRuns / total : null,
  };
}

/**
 * Build the delegation-evidence report over the given sessions (or every session
 * on the tape when none are named). Pure over the tape: no filesystem, no clock,
 * no mutation — the same records always produce the same report.
 */
export function buildDelegationEvidenceReport(
  runtime: EvidenceRuntime,
  options: DelegationEvidenceReportOptions = {},
): DelegationEvidenceReport {
  const named = options.sessionIds ?? [];
  const sessionIds =
    named.length > 0 ? [...new Set(named)] : [...listRuntimeEventSessionIds(runtime)];
  const sessions = sessionIds.toSorted().map((sessionId): DelegationEvidenceSessionReport => {
    const records = listRuntimeEvents(runtime, sessionId);
    const delegation = projectSessionDelegationState({ sessionId, records });
    return {
      sessionId,
      counts: countDelegations(delegation.runs),
      parallelRejections: countParallelRejections(records),
      failures: countFailures(records),
      adoption: countAdoption(records),
      contextEconomics: measureContextEconomics(delegation.runs),
      // The report stores nothing new (axiom 6): re-derive the same tape-folded
      // fitness projection the runtime brief reads and take its independence-debt
      // census (open / violated / dischargedAtGrade — the close-edge's discharge
      // outcome), so operator and model views cannot diverge by construction.
      independenceDebt: buildTapeRequirementFitness(records).independenceDebtResolution,
    };
  });
  return { sessions, aggregate: aggregate(sessions) };
}
