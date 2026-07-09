import { classifyCommandClass } from "@brewva/brewva-std/command-class";
import { readNonEmptyString, readStringList } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { FITNESS_DISCREPANCY_GRADES } from "@brewva/brewva-vocabulary/fitness";
import type {
  AtomFitnessState,
  FitnessDiscrepancy,
  FitnessDiscrepancyGrade,
  UnverifiedRequirementDebt,
} from "@brewva/brewva-vocabulary/fitness";
import { readVerificationOutcomeRecordedEventPayload } from "@brewva/brewva-vocabulary/iteration";
import { REVIEW_FINDING_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/review";
import {
  foldTaskLedgerEvents,
  TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/task";
import type {
  RequirementModality,
  RequirementProvenance,
  RequirementRiskClass,
} from "@brewva/brewva-vocabulary/task";
import {
  deriveFirstWriteInvocationAt,
  projectToolInvocations,
} from "@brewva/brewva-vocabulary/tool-invocations";
import { summarizeRequirementFitness } from "./fitness-summary.js";
import {
  buildTapeRequirementFitness,
  buildTapeUnverifiedRequirementDebt,
} from "./requirement-fitness.js";
import { buildTapeReviewDebt } from "./review-debt.js";

/**
 * Run report: the story of a session reconstructed from its tape.
 *
 * Pure read-side projection — same evidence as the Work Card, no new
 * authority. It answers the questions a trace audit otherwise answers by
 * hand: where did the time go (model gaps vs tool execution vs approval
 * waits), how many error→fix cycles ran, how deep did verification actually
 * go versus what was claimed, and what did skill selection offer versus what
 * was adopted.
 *
 * Input events come from the events port (`ops.events.records.list`), which
 * already flattens runtime-ops custom events into kind-typed records behind a
 * namespace guard — this projection deliberately does NOT re-implement that
 * unwrapping, so it cannot diverge from what Work Card and inspect see.
 */

export interface RunReportToolStat {
  readonly toolName: string;
  readonly calls: number;
  readonly ok: number;
  readonly err: number;
  readonly inconclusive: number;
}

export interface RunReportErrorFixCycle {
  readonly toolName: string;
  readonly erroredAt: number;
  readonly recovered: boolean;
}

export interface RunReportVerification {
  readonly receiptCount: number;
  readonly latestOutcome: string | null;
  readonly latestRung: string | null;
  readonly verificationCommandsObserved: number;
  readonly verificationCommandsGreen: number;
  /**
   * Green verification-class commands ran but no verification receipt was
   * recorded: verification happened below the receipt layer, so every
   * receipt consumer (Work Card Evidence, stall adjudication) stayed blind.
   */
  readonly unreceiptedGreenVerification: boolean;
  /** `verification.outcome.recorded` receipts with `perspective === "authored"` (the default for pre-perspective receipts). */
  readonly authoredReceipts: number;
  /** `verification.outcome.recorded` receipts with `perspective === "independent"`. */
  readonly independentReceipts: number;
  /** Count of `review.finding.recorded` receipts this session. */
  readonly findingsRecorded: number;
  /**
   * The same conservative, tape-only debt rule Work Card evidence uses
   * (`projectTapeReviewDebt`): does the tape's LATEST verification receipt
   * leave review debt behind — a `pass` at `requirements`+ on fresh code with
   * no independent receipt whose `targetRef` still matches (tape-only match:
   * `patch_sets` set-equality, `file_digests` "no patch landed since the
   * receipt"). Never reads the filesystem.
   */
  readonly reviewDebt: boolean;
  /**
   * The LATEST `verification.outcome.recorded` receipt's `discrepancies`,
   * read straight off the payload the vocabulary reader already parses — this
   * projection never re-runs `projectRequirementFitness` (Task 12's join);
   * `verification_record` (Task 13) already computed and committed the
   * annotation onto the receipt at claim time. Empty when the latest receipt
   * carries none (or no receipt exists at all).
   */
  readonly latestDiscrepancies: readonly FitnessDiscrepancy[];
}

/**
 * The requirement-fitness accounting RE-DERIVED over the whole tape
 * (`summarizeRequirementFitness(buildTapeRequirementFitness)`), NOT a snapshot
 * read off the latest receipt. `atomsTotal` folds the tape's requirement atoms
 * directly (`foldTaskLedgerEvents`, the same fold every task-ledger reader uses);
 * `satisfiedAtoms`/`violatedAtoms`/`unverifiedMustAtoms`/`discrepanciesByGrade`
 * come from re-running the per-atom evidence join (`projectRequirementFitness`)
 * over the current tape. Re-deriving is what lands `satisfiedAtoms`: a clear
 * independent atoms-review's affirmative half arrives AFTER the authored verify,
 * so the latest receipt's frozen annotation never carries it. It also fixes the
 * bug where the latest receipt after ANY review is the independent one whose
 * claim-time annotation is empty by design — reading it wholesale falsely
 * reported "nothing unverified". Axiom 6: rebuild the view from receipts; it
 * stores nothing new (the receipt still commits only the negative side).
 */
export interface RunReportFitness {
  readonly atomsTotal: number;
  /** Atoms an independent clear atoms-review affirmatively verified — the positive half. */
  readonly satisfiedAtoms: number;
  readonly violatedAtoms: number;
  readonly unverifiedMustAtoms: number;
  readonly discrepanciesByGrade: Readonly<Record<FitnessDiscrepancyGrade, number>>;
  /**
   * The "green below the requirements rung with unverified `must` atoms" debt
   * (`buildTapeUnverifiedRequirementDebt`) — the pressure the review-debt marker
   * cannot express, surfaced right under the Fitness line. Advisory only.
   */
  readonly unverifiedRequirementDebt: UnverifiedRequirementDebt;
}

/**
 * R5b: one evidence item bearing on an atom, read from a receipt's
 * `evidenceItems` — the claimed-by(`anchors`) detail R5a's baseline lacked,
 * available once structured evidence flows. Empty on atoms with no evidence
 * items yet.
 */
export interface RunReportAtomEvidence {
  readonly verdict: "pass" | "fail";
  readonly anchors: readonly string[];
}

export interface RunReportRequirementAtomLifecycle {
  readonly atomId: string;
  readonly modality: RequirementModality;
  readonly provenance: RequirementProvenance;
  readonly riskClass: RequirementRiskClass | null;
  /** First `task.requirement.recorded` timestamp for this atom id. */
  readonly createdAt: number;
  /** Current fitness state, re-derived over the whole tape (not a frozen receipt). */
  readonly state: AtomFitnessState;
  /** R5b: evidence items bearing on this atom, in tape order. */
  readonly evidence: readonly RunReportAtomEvidence[];
}

/**
 * R5a baseline requirement lifecycle: the tape-only timeline the routing/atomize
 * adoption liveness reads. `atomizedBeforeFirstWrite` is the R1/R2 acceptance
 * predicate (atoms must precede generation's first source mutation);
 * `reviewDispatched` is the close-path-was-attempted signal. Anchors
 * (`claimed-by(file:line)`) and evidence grade are the R5b layer that depends on
 * R3's structured `evidenceItems`; this baseline needs nothing R3 adds.
 */
export interface RunReportRequirementLifecycle {
  /** Earliest requirement-atom mint time — when the spec first became atoms. */
  readonly firstAtomizedAt: number | null;
  /** First successful write-class commitment — when generation first mutated the tree. */
  readonly firstSourceMutationAt: number | null;
  /**
   * Did atomization precede the first source mutation
   * (`firstAtomizedAt <= firstSourceMutationAt`)? `null` when either half is
   * absent — the predicate is undefined, not false.
   */
  readonly atomizedBeforeFirstWrite: boolean | null;
  /** Was an independent review dispatched (a finding or independent receipt exists)? */
  readonly reviewDispatched: boolean;
  readonly atoms: readonly RunReportRequirementAtomLifecycle[];
}

export interface RunReportProjection {
  readonly schema: "brewva.run-report.v1";
  readonly sessionId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly turns: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly toolStats: readonly RunReportToolStat[];
  readonly approvals: {
    readonly requested: number;
    readonly decided: number;
    readonly meanLatencyMs: number | null;
    readonly maxLatencyMs: number | null;
  };
  readonly waits: {
    readonly toolExecutionMs: number;
    readonly approvalMs: number;
    readonly modelGapMs: number;
  };
  readonly errorFixCycles: readonly RunReportErrorFixCycle[];
  readonly verification: RunReportVerification;
  readonly fitness: RunReportFitness;
  readonly requirementLifecycle: RunReportRequirementLifecycle;
  readonly skills: {
    readonly selections: number;
    readonly renderedSkillNames: readonly string[];
    readonly demotedSkillNames: readonly string[];
    readonly forcedCandidates: number;
  };
  readonly cost: {
    readonly totalTokens: number | null;
    readonly includesEstimates: boolean;
  };
}

/** Total-function record coercion; the type logic lives in brewva-std. */
function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Non-empty payload string or null; the string rule lives in brewva-std. */
function readString(record: Record<string, unknown>, key: string): string | null {
  return readNonEmptyString(record[key]) ?? null;
}

function readCall(payload: Record<string, unknown>): {
  toolCallId: string | null;
  toolName: string | null;
  command: string | null;
} {
  const call = toRecord(payload.call);
  const args = toRecord(call.args);
  return {
    toolCallId: readString(call, "toolCallId") ?? readString(payload, "toolCallId"),
    toolName: readString(call, "toolName") ?? readString(payload, "toolName"),
    command: readString(args, "command"),
  };
}

function readOutcomeKind(payload: Record<string, unknown>): string | null {
  const result = toRecord(payload.result);
  const outcome = toRecord(result.outcome);
  return readString(outcome, "kind");
}

function round(value: number): number {
  return Math.round(value);
}

interface MutableErrorFixCycle {
  toolName: string;
  erroredAt: number;
  recovered: boolean;
}

export function buildRunReportProjection(
  sessionId: string,
  events: readonly BrewvaEventRecord[],
): RunReportProjection {
  const ordered = [...events].toSorted((left, right) => left.timestamp - right.timestamp);

  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let turns = 0;
  let assistantMessages = 0;

  const toolStats = new Map<string, { calls: number; ok: number; err: number; inc: number }>();
  const proposedAt = new Map<string, number>();
  const startedAtByCall = new Map<string, number>();
  const approvalRequestedAt = new Map<string, number>();
  const approvalLatencies: number[] = [];
  let approvalRequested = 0;
  let approvalDecided = 0;

  let toolExecutionMs = 0;
  let approvalMs = 0;
  let modelGapMs = 0;
  let lastCommitTimestamp: number | null = null;

  const errorFixCycles: MutableErrorFixCycle[] = [];
  const lastErrorByTool = new Map<string, MutableErrorFixCycle>();

  let verificationReceipts = 0;
  let latestVerificationOutcome: string | null = null;
  let latestVerificationRung: string | null = null;
  let verificationCommandsObserved = 0;
  let verificationCommandsGreen = 0;
  let authoredReceipts = 0;
  let independentReceipts = 0;
  let findingsRecorded = 0;
  // The LATEST verification.outcome.recorded receipt's OWN claim-time
  // discrepancies — replaced wholesale on every receipt seen, in tape order, so
  // the final value is exactly the most recent claim's committed field. This
  // feeds only the `verification` line (what the last verify itself asserted);
  // the re-derived Fitness section owns the current-truth violated/unverified
  // tally, so no `unverifiedMustAtoms` snapshot is needed here.
  let latestDiscrepancies: readonly FitnessDiscrepancy[] = [];

  let skillSelections = 0;
  const renderedSkillNames = new Set<string>();
  const demotedSkillNames = new Set<string>();
  let forcedCandidates = 0;

  let totalTokens = 0;
  let sawTokens = false;
  let includesEstimates = false;

  // R5a: per-atom first-mint time and the earliest atomization, read straight
  // off `task.requirement.recorded` in tape order — the baseline the adoption
  // liveness compares against the first source mutation.
  let firstAtomizedAt: number | null = null;
  const atomCreatedAt = new Map<string, number>();
  // R5b: evidence items bearing on each atom, gathered from receipts.
  const atomEvidence = new Map<string, RunReportAtomEvidence[]>();

  for (const event of ordered) {
    if (startedAt === null) {
      startedAt = event.timestamp;
    }
    endedAt = event.timestamp;

    switch (event.type) {
      case "turn.started": {
        turns += 1;
        // A commit -> next-proposal gap only measures the model when both
        // ends sit inside one turn; across turns it would book human idle
        // time between prompts as model thinking.
        lastCommitTimestamp = null;
        continue;
      }
      case "msg.committed": {
        assistantMessages += 1;
        continue;
      }
      case "tool.proposed": {
        const payload = toRecord(event.payload);
        const call = readCall(payload);
        if (call.toolCallId) {
          proposedAt.set(call.toolCallId, event.timestamp);
        }
        // Time between the previous commitment and the next proposal is the
        // model thinking/generating — attribute it to the model gap.
        if (lastCommitTimestamp !== null) {
          modelGapMs += Math.max(0, event.timestamp - lastCommitTimestamp);
          lastCommitTimestamp = null;
        }
        continue;
      }
      case "tool.started": {
        const call = readCall(toRecord(event.payload));
        if (call.toolCallId) {
          startedAtByCall.set(call.toolCallId, event.timestamp);
        }
        continue;
      }
      case "tool.committed":
      case "tool.aborted": {
        const payload = toRecord(event.payload);
        const call = readCall(payload);
        const toolName = call.toolName ?? "unknown";
        const outcome = event.type === "tool.aborted" ? "err" : (readOutcomeKind(payload) ?? "ok");
        const stat = toolStats.get(toolName) ?? {
          calls: 0,
          ok: 0,
          err: 0,
          inc: 0,
        };
        stat.calls += 1;
        if (outcome === "ok") stat.ok += 1;
        else if (outcome === "err") stat.err += 1;
        else stat.inc += 1;
        toolStats.set(toolName, stat);

        // Aborted calls may never have started (denied/expired approvals):
        // counting from the proposal would double-book the approval wait as
        // execution time, so aborts only count from an actual start.
        const begin =
          event.type === "tool.aborted"
            ? call.toolCallId
              ? startedAtByCall.get(call.toolCallId)
              : undefined
            : ((call.toolCallId ? startedAtByCall.get(call.toolCallId) : undefined) ??
              (call.toolCallId ? proposedAt.get(call.toolCallId) : undefined));
        if (begin !== undefined) {
          toolExecutionMs += Math.max(0, event.timestamp - begin);
        }
        lastCommitTimestamp = event.timestamp;

        if (outcome === "err") {
          const cycle: MutableErrorFixCycle = {
            toolName,
            erroredAt: event.timestamp,
            recovered: false,
          };
          errorFixCycles.push(cycle);
          lastErrorByTool.set(toolName, cycle);
        } else if (outcome === "ok") {
          const pending = lastErrorByTool.get(toolName);
          if (pending) {
            pending.recovered = true;
            lastErrorByTool.delete(toolName);
          }
        }

        if (call.command && classifyCommandClass(call.command) === "verification") {
          verificationCommandsObserved += 1;
          if (outcome === "ok") {
            verificationCommandsGreen += 1;
          }
        }
        continue;
      }
      case "approval.requested": {
        approvalRequested += 1;
        const payload = toRecord(event.payload);
        const requestId = readString(payload, "id") ?? readString(payload, "requestId");
        if (requestId) {
          approvalRequestedAt.set(requestId, event.timestamp);
        }
        continue;
      }
      case "approval.decided": {
        approvalDecided += 1;
        const payload = toRecord(event.payload);
        const requestId = readString(payload, "requestId") ?? readString(payload, "id");
        const requestedTimestamp = requestId ? approvalRequestedAt.get(requestId) : undefined;
        if (requestedTimestamp !== undefined) {
          const latency = Math.max(0, event.timestamp - requestedTimestamp);
          approvalLatencies.push(latency);
          approvalMs += latency;
        }
        continue;
      }
      case "verification.outcome.recorded": {
        const payload = toRecord(event.payload);
        verificationReceipts += 1;
        latestVerificationOutcome = readString(payload, "outcome");
        latestVerificationRung = readString(payload, "level");
        // The typed reader (not local ad hoc parsing) so the perspective split
        // — and the fitness annotation below — can never diverge from what
        // every other receipt consumer (Work Card, inspect report) sees; the
        // full-tape debt fold (below, after the loop) reuses this same reader
        // independently via `buildTapeReviewDebt`, so this pass only needs
        // the perspective count and the latest fitness fields.
        const parsed = readVerificationOutcomeRecordedEventPayload(event);
        if (parsed.perspective === "independent") {
          independentReceipts += 1;
        } else {
          authoredReceipts += 1;
        }
        // R5b: gather each receipt's evidence items by the atom(s) they name.
        for (const item of parsed.evidenceItems) {
          for (const atomId of item.atomRefs) {
            const list = atomEvidence.get(atomId) ?? [];
            list.push({ verdict: item.verdict, anchors: item.anchors });
            atomEvidence.set(atomId, list);
          }
        }
        // Replaced wholesale (not merged) on every receipt, in tape order: the
        // LATEST claim's own committed discrepancies, surfaced verbatim on the
        // verification line as "what the last verify asserted". This is NOT the
        // fitness view — that re-derives over the whole tape below.
        latestDiscrepancies = parsed.discrepancies;
        continue;
      }
      case REVIEW_FINDING_RECORDED_EVENT_TYPE: {
        findingsRecorded += 1;
        continue;
      }
      case TASK_REQUIREMENT_RECORDED_EVENT_TYPE: {
        const atom = toRecord(toRecord(event.payload).atom);
        const atomId = readString(atom, "id");
        if (atomId && !atomCreatedAt.has(atomId)) {
          atomCreatedAt.set(atomId, event.timestamp);
          if (firstAtomizedAt === null) {
            firstAtomizedAt = event.timestamp;
          }
        }
        continue;
      }
      case "skill.selection.recorded": {
        const payload = toRecord(event.payload);
        skillSelections += 1;
        const rendered = payload.renderedSkillReasons;
        if (Array.isArray(rendered)) {
          for (const entry of rendered) {
            const name = readString(toRecord(entry), "name");
            if (name) renderedSkillNames.add(name);
          }
        }
        for (const name of readStringList(payload.demotedSkillNames)) {
          demotedSkillNames.add(name);
        }
        if (Array.isArray(payload.forcedCandidates)) {
          forcedCandidates += payload.forcedCandidates.length;
        }
        continue;
      }
      case "cost.observed": {
        const payload = toRecord(event.payload);
        const tokens =
          typeof payload.totalTokens === "number"
            ? payload.totalTokens
            : typeof payload.tokens === "number"
              ? payload.tokens
              : null;
        if (tokens !== null && Number.isFinite(tokens) && tokens > 0) {
          totalTokens += tokens;
          sawTokens = true;
        }
        if (payload.estimated === true) {
          includesEstimates = true;
        }
        continue;
      }
      default:
        continue;
    }
  }

  const toolCallEntries = [...toolStats.entries()]
    .map(([toolName, stat]) => ({
      toolName,
      calls: stat.calls,
      ok: stat.ok,
      err: stat.err,
      inconclusive: stat.inc,
    }))
    .toSorted(
      (left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName),
    );

  // Same shared fold Work Card and the inspect report use (`buildTapeReviewDebt`)
  // — a full-tape pass over the original `events`, not the ordered/switched
  // loop above, so it can not diverge by depending on this projection's own
  // per-field accumulation order.
  const reviewDebt = buildTapeReviewDebt(events).debt;

  // Requirement atoms fold from the tape directly (the same shared vocabulary
  // fold every task-ledger reader uses), independent of the switch above. The
  // folded state is reused for the per-atom lifecycle below (one fold).
  const taskState = foldTaskLedgerEvents(events);
  const atomsTotal = taskState.requirements.length;
  // Re-derive the CURRENT fitness over the WHOLE tape (buildTapeRequirementFitness,
  // shared with the Work Card fitness line) rather than reading the latest
  // receipt's frozen annotation: a clear independent atoms-review's `satisfied`
  // lands AFTER the authored verify in the natural order, and the latest receipt
  // after any review is the independent one whose claim-time annotation is empty
  // by design — reading it would report a false "nothing unverified". This one
  // projection is reused for both the by-grade summary and the per-atom lifecycle
  // state below (one join serves the two R5a reads). `buildTapeUnverified-
  // RequirementDebt` below still derives its own fitness independently — a
  // pre-existing read-model redundancy left single-homed rather than threaded,
  // since correctness (not CPU) governs a projection.
  const fitnessProjection = buildTapeRequirementFitness(events);
  const fitnessSummary = summarizeRequirementFitness(fitnessProjection);
  const fitness: RunReportFitness = {
    atomsTotal,
    satisfiedAtoms: fitnessSummary.satisfied,
    violatedAtoms: fitnessSummary.violated,
    unverifiedMustAtoms: fitnessSummary.unverifiedMust,
    discrepanciesByGrade: fitnessSummary.discrepanciesByGrade,
    // Sibling to reviewDebt but for the BELOW-requirements case: fresh code +
    // unverified `must` atoms, judged once over the whole tape. Surfaces the
    // "artifact-green that never graded the atoms" termination shape run-report
    // exists to catch.
    unverifiedRequirementDebt: buildTapeUnverifiedRequirementDebt(events),
  };

  // R5a: the tape-only baseline lifecycle. `firstSourceMutationAt` reuses the
  // shared bare-write classifier; per-atom `state` reuses the fitness projection
  // built above (this adds no new join). `atomizedBeforeFirstWrite` is the
  // adoption-liveness predicate — `null` when either half is absent, and `<=` so
  // a tie reads as "atoms did not lag the write".
  const atomState = new Map(fitnessProjection.atoms.map((atom) => [atom.atomId, atom.state]));
  const firstSourceMutationAt = deriveFirstWriteInvocationAt(projectToolInvocations(events));
  const requirementLifecycle: RunReportRequirementLifecycle = {
    firstAtomizedAt,
    firstSourceMutationAt,
    atomizedBeforeFirstWrite:
      firstAtomizedAt === null || firstSourceMutationAt === null
        ? null
        : firstAtomizedAt <= firstSourceMutationAt,
    reviewDispatched: findingsRecorded > 0 || independentReceipts > 0,
    // `taskState.requirements`, `fitnessProjection.atoms`, and `atomCreatedAt`
    // all derive from the SAME task-ledger fold, so every atom id is present in
    // both maps — the `??` fallbacks are unreachable, kept only for `Map.get`.
    atoms: taskState.requirements.map((atom) => ({
      atomId: atom.id,
      modality: atom.modality,
      provenance: atom.provenance,
      riskClass: atom.riskClass ?? null,
      createdAt: atomCreatedAt.get(atom.id) ?? 0,
      state: atomState.get(atom.id) ?? "unverified",
      evidence: atomEvidence.get(atom.id) ?? [],
    })),
  };

  return {
    schema: "brewva.run-report.v1",
    sessionId,
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    turns,
    assistantMessages,
    toolCalls: toolCallEntries.reduce((sum, entry) => sum + entry.calls, 0),
    toolStats: toolCallEntries,
    approvals: {
      requested: approvalRequested,
      decided: approvalDecided,
      meanLatencyMs:
        approvalLatencies.length > 0
          ? round(
              approvalLatencies.reduce((sum, value) => sum + value, 0) / approvalLatencies.length,
            )
          : null,
      maxLatencyMs: approvalLatencies.length > 0 ? Math.max(...approvalLatencies) : null,
    },
    waits: {
      toolExecutionMs: round(toolExecutionMs),
      approvalMs: round(approvalMs),
      modelGapMs: round(modelGapMs),
    },
    errorFixCycles,
    verification: {
      receiptCount: verificationReceipts,
      latestOutcome: latestVerificationOutcome,
      latestRung: latestVerificationRung,
      verificationCommandsObserved,
      verificationCommandsGreen,
      unreceiptedGreenVerification: verificationCommandsGreen > 0 && verificationReceipts === 0,
      authoredReceipts,
      independentReceipts,
      findingsRecorded,
      reviewDebt,
      latestDiscrepancies,
    },
    fitness,
    requirementLifecycle,
    skills: {
      selections: skillSelections,
      renderedSkillNames: [...renderedSkillNames].toSorted((left, right) =>
        left.localeCompare(right),
      ),
      demotedSkillNames: [...demotedSkillNames].toSorted((left, right) =>
        left.localeCompare(right),
      ),
      forcedCandidates,
    },
    cost: {
      totalTokens: sawTokens ? round(totalTokens) : null,
      includesEstimates,
    },
  };
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "n/a";
  }
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1_000;
  if (seconds < 90) {
    return `${seconds.toFixed(1)}s`;
  }
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function formatRunReportText(report: RunReportProjection): string {
  const lines: string[] = [];
  lines.push(`Run Report: schema=${report.schema} session=${report.sessionId}`);
  lines.push(
    `Span: duration=${formatDuration(report.durationMs)} turns=${report.turns} assistantMessages=${report.assistantMessages}`,
  );
  const topTools = report.toolStats
    .slice(0, 8)
    .map((stat) => {
      const failures = stat.err > 0 ? ` err=${stat.err}` : "";
      const inconclusive = stat.inconclusive > 0 ? ` inconclusive=${stat.inconclusive}` : "";
      return `${stat.toolName}=${stat.calls}${failures}${inconclusive}`;
    })
    .join(" ");
  lines.push(`Tools: total=${report.toolCalls} ${topTools}`.trimEnd());
  lines.push(
    `Waits: toolExecution=${formatDuration(report.waits.toolExecutionMs)} approvals=${formatDuration(report.waits.approvalMs)} modelGaps=${formatDuration(report.waits.modelGapMs)}`,
  );
  lines.push(
    `Approvals: requested=${report.approvals.requested} decided=${report.approvals.decided} meanLatency=${formatDuration(report.approvals.meanLatencyMs)} maxLatency=${formatDuration(report.approvals.maxLatencyMs)}`,
  );
  const recovered = report.errorFixCycles.filter((cycle) => cycle.recovered).length;
  const unrecovered = report.errorFixCycles.length - recovered;
  lines.push(
    `Error->Fix: cycles=${report.errorFixCycles.length} recovered=${recovered} unrecovered=${unrecovered}${
      report.errorFixCycles.length > 0
        ? ` (${report.errorFixCycles
            .slice(0, 6)
            .map((cycle) => `${cycle.toolName}${cycle.recovered ? "" : "!"}`)
            .join(", ")})`
        : ""
    }`,
  );
  const verification = report.verification;
  const verificationSummary =
    verification.receiptCount > 0
      ? `receipts=${verification.receiptCount} latest=${verification.latestOutcome ?? "unknown"}@${verification.latestRung ?? "unspecified"}`
      : "receipts=0";
  const debt = verification.unreceiptedGreenVerification
    ? " debt=green-verification-without-receipt"
    : "";
  // The latest receipt's fitness discrepancies, named by atom id — a compact
  // pointer into the dedicated Fitness: line below, surfaced right where the
  // rest of the verification story already lives.
  const latestDiscrepancySuffix =
    verification.latestDiscrepancies.length > 0
      ? ` latestDiscrepancies=${verification.latestDiscrepancies
          .map((entry) => `${entry.atomId}(${entry.grade})`)
          .join(", ")}`
      : "";
  lines.push(
    `Verification: ${verificationSummary} commandsObserved=${verification.verificationCommandsObserved} commandsGreen=${verification.verificationCommandsGreen}${debt}${latestDiscrepancySuffix}`,
  );
  lines.push(
    `Verification perspective: authored=${verification.authoredReceipts} independent=${verification.independentReceipts} findings=${verification.findingsRecorded} reviewDebt=${verification.reviewDebt}`,
  );
  // Fitness section is omitted entirely when no requirement atoms exist —
  // there is nothing to account for, mirroring `verification_record`'s own
  // omit-when-empty summary-line convention (Task 13).
  if (report.fitness.atomsTotal > 0) {
    // Rendered by ITERATING FITNESS_DISCREPANCY_GRADES (not two named fields)
    // so a future third grade appears in the printed line automatically.
    const byGrade = FITNESS_DISCREPANCY_GRADES.map(
      (grade) => `${grade}=${report.fitness.discrepanciesByGrade[grade]}`,
    ).join(" ");
    lines.push(
      `Fitness: atoms=${report.fitness.atomsTotal} satisfied=${report.fitness.satisfiedAtoms} ` +
        `violated=${report.fitness.violatedAtoms} unverifiedMust=${report.fitness.unverifiedMustAtoms} ${byGrade}`,
    );
    // The below-requirements requirement-verification debt: only when it fires
    // (fresh code + >=1 unverified `must` atom). Names the reason so the operator
    // sees WHY — the ladder stopped short vs a requirements pass left atoms
    // ungraded — the exact "artifact-green looks done" gap.
    const requirementDebt = report.fitness.unverifiedRequirementDebt;
    if (requirementDebt.debt && requirementDebt.reason) {
      lines.push(
        `Requirement debt: unverifiedMust=${requirementDebt.unverifiedMustCount} ` +
          `reason=${requirementDebt.reason} (climb to a requirements-level verify or record notApplicable)`,
      );
    }
  }
  // R5a: the requirement lifecycle baseline — when the spec became atoms vs when
  // generation first wrote, whether a review was dispatched, and each atom's
  // current state. `atomizedBeforeFirstWrite=no` is the "atomized-after-the-write"
  // shape; `reviewDispatched=no` with unverified atoms is the never-reviewed shape.
  const lifecycle = report.requirementLifecycle;
  if (lifecycle.atoms.length > 0) {
    const yesNo = (value: boolean | null): string =>
      value === null ? "n/a" : value ? "yes" : "no";
    const offset = (at: number | null): string =>
      at !== null && report.startedAt !== null
        ? `+${formatDuration(at - report.startedAt)}`
        : "n/a";
    lines.push(
      `Requirement lifecycle: atomizedBeforeFirstWrite=${yesNo(lifecycle.atomizedBeforeFirstWrite)} ` +
        `firstAtomized=${offset(lifecycle.firstAtomizedAt)} firstWrite=${offset(lifecycle.firstSourceMutationAt)} ` +
        `reviewDispatched=${yesNo(lifecycle.reviewDispatched)}`,
    );
    for (const atom of lifecycle.atoms) {
      // R5b: closed-by(verdict@anchor) — the anchored evidence that decided the
      // atom, when structured items exist.
      const closedBy =
        atom.evidence.length > 0
          ? ` closedBy=[${atom.evidence
              .map(
                (entry) => entry.verdict + (entry.anchors.length > 0 ? `@${entry.anchors[0]}` : ""),
              )
              .join(", ")}]`
          : "";
      lines.push(
        `  ${atom.atomId}(${atom.modality}/${atom.provenance}/${atom.riskClass ?? "unclassified"}) ` +
          `created=${offset(atom.createdAt)} state=${atom.state}${closedBy}`,
      );
    }
  }
  lines.push(
    `Skills: selections=${report.skills.selections} rendered=${
      report.skills.renderedSkillNames.length > 0
        ? report.skills.renderedSkillNames.join(", ")
        : "none"
    } demoted=${
      report.skills.demotedSkillNames.length > 0
        ? report.skills.demotedSkillNames.join(", ")
        : "none"
    } forcedCandidates=${report.skills.forcedCandidates}`,
  );
  lines.push(
    `Cost: totalTokens=${report.cost.totalTokens ?? "unavailable"}${
      report.cost.includesEstimates ? " (includes estimates)" : ""
    }`,
  );
  return lines.join("\n");
}
