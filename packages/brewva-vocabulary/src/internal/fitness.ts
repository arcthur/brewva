import { reviewTargetRefMatchesTapeOnly } from "./review.js";
import type { ReviewFindingRecordedEventPayload } from "./review.js";
import type { RequirementAtom, RequirementRiskClass } from "./task.js";

/**
 * How well one requirement atom is met, given the evidence joined against it.
 *
 * - `satisfied`: deterministic OR independent evidence that NAMES the atom
 *   asserts a pass; the strongest positive state.
 * - `likelySatisfied`: only author-claimed coverage supports it — believable
 *   but self-attested, so it never reaches `satisfied` on its own.
 * - `violated`: a live (non-stale) fail exists — a deterministic fail entry or
 *   a review finding on the atom; always accompanied by a graded discrepancy.
 * - `unverified`: no live evidence bears on the atom (or the only evidence was
 *   stale and dropped).
 * - `notApplicable`: an atom explicitly marked as not applicable. The current
 *   {@link RequirementAtom} shape carries NO such marker, so this state is
 *   UNREACHABLE from this join today — it is kept in the vocabulary for a later
 *   surface that may supply the marker, and this projection never produces it.
 */
export const ATOM_FITNESS_STATES = [
  "satisfied",
  "likelySatisfied",
  "violated",
  "unverified",
  "notApplicable",
] as const;

export type AtomFitnessState = (typeof ATOM_FITNESS_STATES)[number];

/**
 * How WELL an evidence item knows its atom — ORTHOGONAL to `kind` (which names
 * WHERE it came from). `presence` is a token/AST-presence match (a `grep` for
 * `keyCode 63`); `static_guard` is a deterministic predicate over the code's
 * guards (does the tap re-enable on timeout?); `behavioral` is an executed
 * runtime probe. A negative/failure-mode property is invisible to `presence` and
 * only knowable at `static_guard` or above — which is why a high-risk atom's
 * required minimum grade caps what `presence`-only evidence can prove (see
 * {@link projectRequirementFitness}). This is the grade axis; the
 * `authored`/`independent` perspective axis is separate and complementary.
 */
export const EVIDENCE_KINDS = ["presence", "static_guard", "behavioral"] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const EVIDENCE_KIND_RANK: Readonly<Record<EvidenceKind, number>> = {
  presence: 0,
  static_guard: 1,
  behavioral: 2,
};

/**
 * How MUCH of the atom an evidence item's attribution covers — the THIRD axis,
 * orthogonal to source (`kind`) and grade (`evidenceKind`). `property`: the
 * checked property IS the atom's statement (a trap-declared adapter binding),
 * so a pass at grade discharges the atom. `facet`: the atom merely DECLARED the
 * checked construct among its observable signals — the check covers one facet
 * of a broader statement. Falsification is asymmetric (axiom 7): a facet FAIL
 * convicts the atom (its own declared evidence basis is deterministically
 * broken), but a facet PASS proves only that one facet and can never satisfy —
 * or even "likely" — the whole atom. An item that omits coverage is `property`
 * (every item before this axis existed was routed as whole-property evidence,
 * and replayed tapes keep their recorded meaning).
 */
export const EVIDENCE_COVERAGES = ["property", "facet"] as const;

export type EvidenceCoverage = (typeof EVIDENCE_COVERAGES)[number];

/**
 * One piece of evidence that contributed to an atom's fitness state. `kind`
 * names WHERE it came from (source); `evidenceKind` names HOW WELL it knows the
 * atom (grade) — the two axes are orthogonal. `ref` is the evidence's stable id
 * (finding id, outcome ref, or deterministic entry ref); `verdict` is present for
 * the kinds that carry pass/fail (`authored` coverage carries no verdict — it
 * only claims the atom was addressed, not that a check passed).
 *
 * This is intentionally the minimum the states and discrepancies need: the
 * projection has no authority (axiom 18), so it records only enough for a reader
 * to see WHAT decided the state, not to re-adjudicate it.
 */
export interface AtomFitnessEvidence {
  readonly kind: "finding" | "independent_outcome" | "deterministic" | "authored";
  readonly evidenceKind: EvidenceKind;
  readonly ref: string;
  readonly verdict?: "pass" | "fail";
  /**
   * Present (as `facet`) only on deterministic entries whose attribution covers
   * one declared construct facet, not the whole property — so a reader can see
   * WHY a deterministic pass in the trail did not discharge the atom. Absent
   * means `property`.
   */
  readonly coverage?: EvidenceCoverage;
}

export interface AtomFitness {
  readonly atomId: string;
  readonly state: AtomFitnessState;
  /** What decided the state, sorted deterministically by (kind, ref, verdict). */
  readonly evidence: readonly AtomFitnessEvidence[];
}

/**
 * The two discrepancy grades a violated atom can carry, in the vocabulary's
 * own words (RFC-verbatim): `deterministic_conflict` when a deterministic
 * evidence entry (scripted check, gate) drove the violation, `advisory_conflict`
 * when only an LLM review finding did. SINGLE-HOMED here — every site that
 * checks or enumerates a grade (the receipt reader's `isFitnessDiscrepancy`,
 * `verification_record`'s claim-time summary, `inspect run-report`'s
 * discrepancies-by-grade tally) imports this instead of holding its own
 * literal union, so a future third grade is added in exactly one place and
 * every `Record<FitnessDiscrepancyGrade, ...>` built by iterating this tuple
 * becomes total by construction.
 */
export const FITNESS_DISCREPANCY_GRADES = ["deterministic_conflict", "advisory_conflict"] as const;

export type FitnessDiscrepancyGrade = (typeof FITNESS_DISCREPANCY_GRADES)[number];

/**
 * A surfaced conflict for a `violated` atom. `grade` records whether a
 * deterministic entry drove the violation (`deterministic_conflict`) or only an
 * LLM review finding did (`advisory_conflict`) — only deterministic evidence
 * can produce `deterministic_conflict`. `evidenceRef` points at the specific
 * fail evidence (deterministic entry ref or finding id) so a reader can trace
 * the claim.
 */
export interface FitnessDiscrepancy {
  readonly atomId: string;
  readonly grade: FitnessDiscrepancyGrade;
  readonly statement: string;
  readonly evidenceRef: string;
}

/**
 * A high-risk atom whose only satisfying evidence is BELOW the grade its risk
 * class requires — positive coverage exists, but at a grade too weak to prove the
 * atom's failure-mode property (a presence grep cannot see a missing guard). This
 * is DISTINCT from a {@link FitnessDiscrepancy}: it is neither a violation nor a
 * fail, so it is NOT a discrepancy grade — it is honest "not checked well enough"
 * debt (axiom 7). The atom reads `likelySatisfied`, never `satisfied`; only a
 * real `deterministic` FAIL (a static-guard adapter that ran and failed) produces
 * the fail-bearing `deterministic_conflict` the operator gate bridges on.
 */
export interface InsufficientEvidenceGradeDebt {
  readonly atomId: string;
  /** The minimum grade this atom's risk class requires to reach `satisfied`. */
  readonly requiredKind: EvidenceKind;
  /** The best grade among the satisfying passes actually present (below required). */
  readonly actualKind: EvidenceKind;
}

export interface FitnessProjection {
  readonly atoms: readonly AtomFitness[];
  readonly counts: Readonly<Record<AtomFitnessState, number>>;
  readonly discrepancies: readonly FitnessDiscrepancy[];
  readonly unverifiedMustAtoms: readonly string[];
  /**
   * Atoms capped below `satisfied` because their positive coverage is
   * presence-grade on a high-risk class — advisory grade debt, in first-appearance
   * order. Empty when no atom's grade fell short of its risk floor.
   */
  readonly insufficientGradeAtoms: readonly InsufficientEvidenceGradeDebt[];
  /**
   * Ids of `must`-modality atoms on a HIGH-RISK class (runtime/security — a
   * failure-mode floor a presence grep cannot clear) whose state is NOT
   * `satisfied` (i.e. `unverified` or `likelySatisfied`): NO independent OR
   * deterministic pass AT the atom's risk-floor grade bears on them. The atom may
   * be entirely unchecked, author-claimed, OR checked only sub-floor — a presence
   * re-grep, even an INDEPENDENT one, that cannot clear a runtime/security failure
   * mode. In every case an independent read AT GRADE is still owed, so the render
   * must say "no independent read AT GRADE", never "no independent receipt" (a
   * sub-floor independent receipt may exist). This is the at-grade independence
   * gap the delegation surface reads as independence debt (authorship taints
   * verification). First-appearance order. A `violated` atom is excluded: a live
   * fail is a discrepancy, a different signal, not an unmet independence need.
   *
   * ORTHOGONAL to {@link InsufficientEvidenceGradeDebt}: that is the GRADE axis
   * (positive coverage exists but sub-floor), this is the at-grade INDEPENDENCE
   * axis. A high-risk atom with a sub-floor pass legitimately co-appears in BOTH
   * (grade debt AND independence debt); a consumer that renders both lists must
   * not double-count the atom.
   */
  readonly independenceDebtAtoms: readonly string[];
  /**
   * The terminal-state census of the high-risk `must` atoms — the discharge OUTCOME
   * read off the end-of-tape projection (no per-turn history needed), for
   * `report:delegation-evidence`. It buckets by STATE, NOT by evidence source:
   * - `open`: still owes an at-grade read (equals `independenceDebtAtoms.length`);
   * - `reviewedSubGrade`: a SUBSET of `open` — a fresh-context reviewer DID read the
   *   atom but could only presence-grade it, so the grade ceiling capped it at
   *   `likelySatisfied`. This separates "an independent perspective looked, sub-floor"
   *   from the rest of `open` (never read, or author-claimed only). A rising
   *   `reviewedSubGrade` against a flat `dischargedAtGrade` means reviews are LOOKING
   *   but not AT GRADE — the static-guard producer, not another presence review, is
   *   what these atoms are waiting on;
   * - `violated`: a live fail named it as a known break — a review/independent FAIL
   *   OR a deterministic static-guard fail (both reach `violated`);
   * - `dischargedAtGrade`: reached `satisfied` via an at-grade pass — independent OR
   *   deterministic (a presence-grade check, review or grep, CANNOT clear a high-risk
   *   atom: the grade ceiling).
   * A rising `violated` + `dischargedAtGrade` against a flat `open` means high-risk
   * atoms are reaching at-grade closure rather than being left owed — the review→atom
   * fold is ONE driver of that, not the only one, so the census does not attribute the
   * movement to the review channel alone. `reviewedSubGrade` ⊆ `open`, so it is NOT a
   * partition sibling of the other three (which DO sum to the high-risk `must` count).
   */
  readonly independenceDebtResolution: {
    readonly open: number;
    readonly reviewedSubGrade: number;
    readonly violated: number;
    readonly dischargedAtGrade: number;
  };
}

/**
 * A review finding paired with its OWN receipt timestamp. The finding payload
 * ({@link ReviewFindingRecordedEventPayload}) carries `targetRef` and `atomRefs`
 * but no timestamp, so the caller supplies `receiptTimestamp` from the tape
 * event that recorded the finding. Staleness is judged per-finding against this
 * timestamp (mirroring the per-receipt-timestamp discipline of
 * `projectTapeReviewDebt`), never against a shared "latest" timestamp.
 */
export interface FitnessReviewFinding {
  readonly finding: ReviewFindingRecordedEventPayload;
  readonly receiptTimestamp: number;
}

/**
 * An independent-perspective outcome receipt that NAMES the atoms it bears on.
 * A `pass` here is strong positive evidence (can reach `satisfied`); a `fail`
 * is treated as a violation, same as a deterministic fail's downgrade but
 * graded `advisory_conflict` (it is not deterministic evidence).
 */
export interface FitnessIndependentOutcome {
  readonly atomRefs: readonly string[];
  readonly verdict: "pass" | "fail";
  readonly ref: string;
  /**
   * Grade of the check behind this outcome; defaults to `presence` when unset. An
   * independent PASS reaches `satisfied` only if this meets the atom's risk floor
   * — an independent reviewer that merely re-grepped cannot clear a high-risk atom.
   */
  readonly evidenceKind?: EvidenceKind;
}

/**
 * An author-claimed outcome: the same reasoning stream that authored the change
 * asserts it covers these atoms. Author coverage alone yields at most
 * `likelySatisfied` — it never proves satisfaction and never violates.
 */
export interface FitnessAuthoredOutcome {
  readonly atomRefs: readonly string[];
  readonly ref: string;
}

/**
 * A deterministic evidence entry keyed to one atom. The caller maps
 * verification-gate and scripted-check evidence into this shape; the projection
 * only knows it is `deterministic` (a fail here grades `deterministic_conflict`).
 */
export interface DeterministicFitnessEvidence {
  readonly atomId: string;
  readonly verdict: "pass" | "fail";
  readonly ref: string;
  /** Grade of the deterministic check; defaults to `presence` when unset. */
  readonly evidenceKind?: EvidenceKind;
  /**
   * Attribution coverage of the check; defaults to `property` when unset. A
   * `facet` FAIL still convicts (deterministic_conflict); a `facet` PASS is
   * trail-only — it can neither satisfy the atom nor count as a satisfying
   * pass at any grade (see {@link EVIDENCE_COVERAGES}).
   */
  readonly coverage?: EvidenceCoverage;
}

/**
 * The pure input to {@link projectRequirementFitness}. Every field is assembled
 * by the effectful caller from tape receipts; the projection itself does no I/O
 * and reads no clock. `appliedPatchSetRefs` + `latestTreeMutationAt` feed the
 * SAME conservative tape-only staleness matcher (`reviewTargetRefMatchesTapeOnly`)
 * that the review-debt surfaces use — one staleness rule across debt and fitness.
 */
export interface RequirementFitnessInput {
  readonly atoms: readonly RequirementAtom[];
  readonly findings: readonly FitnessReviewFinding[];
  readonly independentOutcomes: readonly FitnessIndependentOutcome[];
  readonly authoredOutcomes: readonly FitnessAuthoredOutcome[];
  readonly deterministicEvidence: readonly DeterministicFitnessEvidence[];
  /** Currently applied patch-set ids, tape-derived — matcher input for `patch_sets` refs. */
  readonly appliedPatchSetRefs: readonly string[];
  /**
   * Latest tape tree-mutation timestamp — a successful patch application,
   * rollback, OR bare write/edit invocation (Finding P1), or null if none —
   * matcher input for `file_digests` staleness. Derived via the shared
   * `deriveLatestTreeMutationAt` fold. See `reviewTargetRefMatchesTapeOnly`.
   */
  readonly latestTreeMutationAt: number | null;
}

/** Ranks an evidence entry for deterministic, order-independent sorting within an atom. */
const EVIDENCE_KIND_ORDER: Readonly<Record<AtomFitnessEvidence["kind"], number>> = {
  deterministic: 0,
  independent_outcome: 1,
  finding: 2,
  authored: 3,
};

function compareEvidence(left: AtomFitnessEvidence, right: AtomFitnessEvidence): number {
  const kindDelta = EVIDENCE_KIND_ORDER[left.kind] - EVIDENCE_KIND_ORDER[right.kind];
  if (kindDelta !== 0) {
    return kindDelta;
  }
  if (left.ref !== right.ref) {
    return left.ref < right.ref ? -1 : 1;
  }
  // Two entries can share (kind, ref) yet differ in verdict (e.g. one outcome
  // ref reused for a pass and a fail on the same atom). Break the tie on verdict
  // so the sort is TOTAL and thus order-independent — otherwise the pre-sort
  // input order would leak into the result.
  const leftVerdict = left.verdict ?? "";
  const rightVerdict = right.verdict ?? "";
  if (leftVerdict !== rightVerdict) {
    return leftVerdict < rightVerdict ? -1 : 1;
  }
  // ... and finally on coverage: the same (kind, ref, verdict) can appear once
  // attributed as whole-property and once as facet (e.g. a pre-coverage tape
  // entry replayed next to a re-recorded facet item) — totality again.
  const leftCoverage = left.coverage ?? "";
  const rightCoverage = right.coverage ?? "";
  return leftCoverage < rightCoverage ? -1 : leftCoverage > rightCoverage ? 1 : 0;
}

/**
 * The minimum evidence grade at which a satisfying pass may move a high-risk atom
 * to `satisfied`. A failure-mode class — `runtime` (event-tap re-enable, input
 * source, pasteboard, speech lifecycle) and `security` (credential/privacy) —
 * needs at least a `static_guard` predicate; presence-only coverage caps at
 * `likelySatisfied` and raises {@link InsufficientEvidenceGradeDebt}. Classes
 * absent here (`ux`/`packaging`/`architecture`) and unclassified atoms accept
 * `presence`.
 *
 * This map is ALSO the single source of "high risk" for {@link
 * FitnessProjection.independenceDebtAtoms}: a class with a floor ABOVE `presence`
 * is exactly the class that owes an independent read at grade. When adding a
 * class here, confirm "a sub-floor pass owes an at-grade independent perspective"
 * holds for it — true for failure-mode classes; a class wanting only build
 * determinism (not an independent review) would not want that framing.
 */
const MIN_EVIDENCE_KIND_BY_RISK: Partial<Record<RequirementRiskClass, EvidenceKind>> = {
  runtime: "static_guard",
  security: "static_guard",
};

function requiredEvidenceKind(atom: RequirementAtom): EvidenceKind {
  return (atom.riskClass ? MIN_EVIDENCE_KIND_BY_RISK[atom.riskClass] : undefined) ?? "presence";
}

function meetsRequiredGrade(atom: RequirementAtom, kind: EvidenceKind): boolean {
  return EVIDENCE_KIND_RANK[kind] >= EVIDENCE_KIND_RANK[requiredEvidenceKind(atom)];
}

function higherGrade(current: EvidenceKind | null, next: EvidenceKind): EvidenceKind {
  if (current === null) {
    return next;
  }
  return EVIDENCE_KIND_RANK[next] > EVIDENCE_KIND_RANK[current] ? next : current;
}

/** Mutable accumulator for one atom while the join folds evidence into it. */
interface AtomAccumulator {
  readonly atom: RequirementAtom;
  readonly evidence: AtomFitnessEvidence[];
  /** A deterministic pass AT OR ABOVE the atom's required grade — reaches `satisfied`. */
  hasDeterministicPass: boolean;
  /** An independent pass AT OR ABOVE the atom's required grade — reaches `satisfied`. */
  hasIndependentPass: boolean;
  /**
   * An INDEPENDENT pass that landed BELOW the atom's required grade — a fresh-context
   * reviewer that read the atom but could only presence-grade it, so it caps at
   * `likelySatisfied` (the grade ceiling) rather than `satisfied`. Distinct from
   * `bestSatisfyingKind !== null`, which a DETERMINISTIC sub-floor pass also sets: this
   * flag is TRUE only when an independent PERSPECTIVE produced the sub-floor read, so the
   * census can separate "a reviewer looked but was capped" from "only a grep/author touched it".
   */
  hasIndependentSubfloorPass: boolean;
  hasAuthored: boolean;
  /**
   * The highest grade among deterministic/independent PASSES seen. When no
   * sufficient pass exists but this is non-null, the atom has sub-floor positive
   * coverage -> `likelySatisfied` + {@link InsufficientEvidenceGradeDebt}.
   */
  bestSatisfyingKind: EvidenceKind | null;
  /** A live deterministic fail, if any — drives `deterministic_conflict`. */
  deterministicFailRef: string | null;
  /** A live finding on this atom, if any — drives `advisory_conflict`. */
  findingFailRef: string | null;
}

/**
 * The pure requirement-fitness projection: join folded requirement atoms
 * against the evidence that bears on them and derive a per-atom fitness state,
 * a per-state tally, graded discrepancies for violations, and the ids of unmet
 * `must` atoms.
 *
 * This is a VIEW with no authority (axiom 18): nothing gates on it and it is
 * rebuildable from receipts alone (axiom 6). It reads no filesystem and no
 * clock, and is order-independent in every evidence array — the same inputs
 * yield a byte-identical projection regardless of receipt order.
 *
 * Join rules (RFC-verbatim):
 * - STALENESS NEVER VIOLATES. A finding whose `targetRef` no longer matches the
 *   current tree (judged by `reviewTargetRefMatchesTapeOnly` against the
 *   finding's OWN `receiptTimestamp`) is dropped entirely: it contributes
 *   nothing to `violated` and no discrepancy. Independent/deterministic
 *   outcomes are keyed to atoms, not to a tree snapshot, so they are not
 *   staleness-checked here (the caller decides which to feed in).
 * - A live fail DOMINATES a coexisting pass. If an atom has both satisfying and
 *   violating evidence, the atom is `violated` and the conflict surfaces — a
 *   pass never masks a real fail.
 * - GRADING: a deterministic fail grades `deterministic_conflict`; a review
 *   finding grades `advisory_conflict`. When both a deterministic fail and a
 *   finding exist, the deterministic grade is preferred (only deterministic
 *   evidence can produce `deterministic_conflict`); each violated atom yields
 *   exactly ONE discrepancy.
 * - `satisfied` requires a deterministic pass keyed to the atom OR an
 *   independent outcome that names it. Author coverage alone caps at
 *   `likelySatisfied`.
 * - No live evidence -> `unverified`.
 * - `notApplicable` is never produced (see {@link ATOM_FITNESS_STATES}).
 * - `unverifiedMustAtoms` = ids of `must`-modality atoms whose state is
 *   `unverified`, in first-appearance order.
 * - `counts` = per-state tally over ALL atoms.
 */
export function projectRequirementFitness(input: RequirementFitnessInput): FitnessProjection {
  const accumulators = new Map<string, AtomAccumulator>();
  const order: string[] = [];
  for (const atom of input.atoms) {
    if (accumulators.has(atom.id)) {
      continue;
    }
    accumulators.set(atom.id, {
      atom,
      evidence: [],
      hasDeterministicPass: false,
      hasIndependentPass: false,
      hasIndependentSubfloorPass: false,
      hasAuthored: false,
      bestSatisfyingKind: null,
      deterministicFailRef: null,
      findingFailRef: null,
    });
    order.push(atom.id);
  }

  for (const entry of input.deterministicEvidence) {
    const accumulator = accumulators.get(entry.atomId);
    if (!accumulator) {
      continue;
    }
    const evidenceKind = entry.evidenceKind ?? "presence";
    const facet = entry.coverage === "facet";
    accumulator.evidence.push(
      facet
        ? {
            kind: "deterministic",
            evidenceKind,
            ref: entry.ref,
            verdict: entry.verdict,
            coverage: "facet",
          }
        : { kind: "deterministic", evidenceKind, ref: entry.ref, verdict: entry.verdict },
    );
    if (entry.verdict === "pass") {
      // Falsification asymmetry (axiom 7): a facet pass proves ONE declared
      // construct facet, never the whole statement — it stays in the trail but
      // is NOT a satisfying pass at any grade (it neither discharges nor
      // "likely"-satisfies, and it must not read as grade debt either — the
      // deficit is coverage, not grade).
      if (!facet) {
        accumulator.bestSatisfyingKind = higherGrade(accumulator.bestSatisfyingKind, evidenceKind);
        if (meetsRequiredGrade(accumulator.atom, evidenceKind)) {
          accumulator.hasDeterministicPass = true;
        }
      }
    } else if (
      accumulator.deterministicFailRef === null ||
      entry.ref < accumulator.deterministicFailRef
    ) {
      // Lowest ref wins so the chosen discrepancy is order-independent. A facet
      // fail convicts like any deterministic fail: the atom's OWN declared
      // evidence basis is deterministically broken.
      accumulator.deterministicFailRef = entry.ref;
    }
  }

  for (const outcome of input.independentOutcomes) {
    const evidenceKind = outcome.evidenceKind ?? "presence";
    for (const atomId of outcome.atomRefs) {
      const accumulator = accumulators.get(atomId);
      if (!accumulator) {
        continue;
      }
      accumulator.evidence.push({
        kind: "independent_outcome",
        evidenceKind,
        ref: outcome.ref,
        verdict: outcome.verdict,
      });
      if (outcome.verdict === "pass") {
        accumulator.bestSatisfyingKind = higherGrade(accumulator.bestSatisfyingKind, evidenceKind);
        if (meetsRequiredGrade(accumulator.atom, evidenceKind)) {
          accumulator.hasIndependentPass = true;
        } else {
          // An independent perspective read this atom but only presence-graded it —
          // it cannot clear a high-risk floor (grade ceiling), so it caps at
          // `likelySatisfied`. Recorded so the independence census can tell "a
          // reviewer looked, sub-floor" apart from "no independent read at all".
          accumulator.hasIndependentSubfloorPass = true;
        }
      } else if (accumulator.findingFailRef === null || outcome.ref < accumulator.findingFailRef) {
        // An independent fail is a non-deterministic violation -> advisory grade,
        // sharing the finding-fail channel (lowest ref wins for determinism).
        accumulator.findingFailRef = outcome.ref;
      }
    }
  }

  for (const authored of input.authoredOutcomes) {
    for (const atomId of authored.atomRefs) {
      const accumulator = accumulators.get(atomId);
      if (!accumulator) {
        continue;
      }
      // Author coverage is a self-claim: weakest grade by construction, and it
      // caps at `likelySatisfied` regardless of grade (the perspective axis, not
      // the grade axis, governs it).
      accumulator.evidence.push({ kind: "authored", evidenceKind: "presence", ref: authored.ref });
      accumulator.hasAuthored = true;
    }
  }

  for (const { finding, receiptTimestamp } of input.findings) {
    const fresh = reviewTargetRefMatchesTapeOnly(finding.targetRef, {
      appliedPatchSetRefs: input.appliedPatchSetRefs,
      receiptTimestamp,
      latestTreeMutationAt: input.latestTreeMutationAt,
    });
    if (!fresh) {
      // STALENESS NEVER VIOLATES: a stale finding is dropped whole — no evidence
      // entry, no violation, no discrepancy. The atom stays unverified unless
      // OTHER live evidence decides it.
      continue;
    }
    for (const atomId of finding.atomRefs) {
      const accumulator = accumulators.get(atomId);
      if (!accumulator) {
        continue;
      }
      // A finding is a violation, not satisfying evidence; grade is not
      // meaningful for a fail, so it records the honest weakest (`presence`).
      accumulator.evidence.push({
        kind: "finding",
        evidenceKind: "presence",
        ref: finding.findingId,
      });
      if (accumulator.findingFailRef === null || finding.findingId < accumulator.findingFailRef) {
        accumulator.findingFailRef = finding.findingId;
      }
    }
  }

  const atoms: AtomFitness[] = [];
  const counts: Record<AtomFitnessState, number> = {
    satisfied: 0,
    likelySatisfied: 0,
    violated: 0,
    unverified: 0,
    notApplicable: 0,
  };
  const discrepancies: FitnessDiscrepancy[] = [];
  const insufficientGradeAtoms: InsufficientEvidenceGradeDebt[] = [];

  for (const atomId of order) {
    const accumulator = accumulators.get(atomId);
    if (!accumulator) {
      continue;
    }
    const state = resolveState(accumulator);
    counts[state] += 1;
    atoms.push({
      atomId,
      state,
      evidence: accumulator.evidence.toSorted(compareEvidence),
    });
    if (state === "violated") {
      discrepancies.push(buildDiscrepancy(accumulator));
    } else if (
      !accumulator.hasDeterministicPass &&
      !accumulator.hasIndependentPass &&
      accumulator.bestSatisfyingKind !== null
    ) {
      // A satisfying pass exists but below this atom's risk floor: positive
      // coverage capped at `likelySatisfied`, surfaced as honest grade debt —
      // never a discrepancy, because no fail exists (axiom 7, not a fake conflict).
      insufficientGradeAtoms.push({
        atomId,
        requiredKind: requiredEvidenceKind(accumulator.atom),
        actualKind: accumulator.bestSatisfyingKind,
      });
    }
  }

  const sortedDiscrepancies = discrepancies.toSorted((left, right) => {
    if (left.atomId !== right.atomId) {
      return left.atomId < right.atomId ? -1 : 1;
    }
    return left.evidenceRef < right.evidenceRef ? -1 : left.evidenceRef > right.evidenceRef ? 1 : 0;
  });

  const unverifiedMustAtoms = atoms
    .filter(
      (entry) =>
        entry.state === "unverified" && accumulators.get(entry.atomId)?.atom.modality === "must",
    )
    .map((entry) => entry.atomId);

  // High-risk `must` atoms carry independence debt until `satisfied`: only an
  // independent OR deterministic-at-grade pass reaches `satisfied`, so an atom stuck
  // at `unverified`/`likelySatisfied` has none — an independent perspective is owed.
  // `presence`-floor (non-high-risk) atoms are excluded: self-review clears those
  // honestly, so demanding independence there would be noise. ONE pass over the same
  // high-risk `must` set also censuses the discharge OUTCOME (violated / at-grade
  // satisfied) for the report — see {@link FitnessProjection.independenceDebtResolution}.
  const independenceDebtAtoms: string[] = [];
  let independenceReviewedSubGrade = 0;
  let independenceViolated = 0;
  let independenceDischargedAtGrade = 0;
  for (const entry of atoms) {
    const accumulator = accumulators.get(entry.atomId);
    if (
      accumulator === undefined ||
      accumulator.atom.modality !== "must" ||
      requiredEvidenceKind(accumulator.atom) === "presence"
    ) {
      continue;
    }
    if (entry.state === "unverified" || entry.state === "likelySatisfied") {
      independenceDebtAtoms.push(entry.atomId); // still owes an at-grade read
      if (accumulator.hasIndependentSubfloorPass) {
        // ⊆ open: a fresh-context reviewer DID read this atom, but only presence-graded
        // it — the grade ceiling capped it at `likelySatisfied`. Separating this from the
        // rest of `open` (unverified, or author-claimed only) tells "a review looked but
        // could not clear the floor" apart from "no independent read happened at all".
        independenceReviewedSubGrade += 1;
      }
    } else if (entry.state === "violated") {
      independenceViolated += 1; // a live fail (review/independent OR deterministic) named it broken
    } else if (entry.state === "satisfied") {
      independenceDischargedAtGrade += 1; // cleared by an at-grade pass (independent OR deterministic)
    }
    // `notApplicable` is intentionally uncounted: `resolveState` never reaches it (no
    // atom marker selects it), so the four reachable states partition the high-risk
    // `must` set. If an N/A marker is ever added, revisit this census's implicit
    // `open + violated + dischargedAtGrade === high-risk-must count` sum.
  }

  return {
    atoms,
    counts,
    discrepancies: sortedDiscrepancies,
    unverifiedMustAtoms,
    insufficientGradeAtoms,
    independenceDebtAtoms,
    independenceDebtResolution: {
      // `open` stays the single count derived from the enumerated list (the list is the
      // authority — it carries the atom IDs the render enumerates); `reviewedSubGrade` is
      // counted in the SAME pass, so no parallel accounting can drift from it.
      open: independenceDebtAtoms.length,
      reviewedSubGrade: independenceReviewedSubGrade,
      violated: independenceViolated,
      dischargedAtGrade: independenceDischargedAtGrade,
    },
  };
}

/**
 * Precedence: a live fail (deterministic OR finding/independent) wins over any
 * pass; then a keyed/independent pass AT OR ABOVE the atom's required grade
 * reaches `satisfied`; then author coverage OR a sub-floor-grade satisfying pass
 * reaches `likelySatisfied`; else `unverified`. `notApplicable` is never reached —
 * no marker exists on the atom to select it.
 */
function resolveState(accumulator: AtomAccumulator): AtomFitnessState {
  if (accumulator.deterministicFailRef !== null || accumulator.findingFailRef !== null) {
    return "violated";
  }
  if (accumulator.hasDeterministicPass || accumulator.hasIndependentPass) {
    return "satisfied";
  }
  // Author coverage OR a sub-floor satisfying pass (positive evidence too weak to
  // reach `satisfied` for this atom's risk class) both read `likelySatisfied`.
  if (accumulator.hasAuthored || accumulator.bestSatisfyingKind !== null) {
    return "likelySatisfied";
  }
  return "unverified";
}

/**
 * Build the single discrepancy for a violated atom. A deterministic fail is
 * preferred (only it grades `deterministic_conflict`); otherwise the finding
 * (or independent-fail) grades `advisory_conflict`.
 */
function buildDiscrepancy(accumulator: AtomAccumulator): FitnessDiscrepancy {
  if (accumulator.deterministicFailRef !== null) {
    return {
      atomId: accumulator.atom.id,
      grade: "deterministic_conflict",
      statement: accumulator.atom.statement,
      evidenceRef: accumulator.deterministicFailRef,
    };
  }
  if (accumulator.findingFailRef === null) {
    // Unreachable by construction: buildDiscrepancy is only called for a
    // `violated` atom, and resolveState returns `violated` only when a
    // deterministic OR a finding fail ref is set. The deterministic branch is
    // taken above, so reaching here with a null finding ref means that invariant
    // was broken by a future refactor. Fail LOUDLY rather than emit an empty
    // evidenceRef that would silently untraceably corrupt the discrepancy.
    throw new Error(
      `fitness invariant violated: advisory discrepancy for atom ${accumulator.atom.id} has no finding fail ref`,
    );
  }
  return {
    atomId: accumulator.atom.id,
    grade: "advisory_conflict",
    statement: accumulator.atom.statement,
    evidenceRef: accumulator.findingFailRef,
  };
}

/**
 * The reason a requirement-verification debt carries, or null when there is no
 * debt.
 *
 * - `ladder_below_requirements`: fresh code was written and >= 1 `must` atom is
 *   `unverified`, and NO verification pass ever reached the `requirements` rung
 *   — the ladder stopped lower (e.g. `artifact`: does it build/sign?) without
 *   grading the atoms against evidence. This is the "green-but-unverified"
 *   termination shape: a build-level pass looks done while the requirements were
 *   never actually checked.
 * - `unverified_after_requirements`: a pass DID reach `requirements`, yet >= 1
 *   `must` atom is STILL `unverified` — a coverage gap, not a skipped rung.
 */
export type UnverifiedRequirementDebtReason =
  | "ladder_below_requirements"
  | "unverified_after_requirements";

/** Descriptive requirement-verification debt (advisory, never a gate — axiom 18). */
export interface UnverifiedRequirementDebt {
  readonly debt: boolean;
  /** Count of `must`-modality atoms whose fitness state is `unverified`. */
  readonly unverifiedMustCount: number;
  readonly reason: UnverifiedRequirementDebtReason | null;
}

/** Inputs {@link projectUnverifiedRequirementDebt} needs — all tape-derived, no I/O. */
export interface UnverifiedRequirementDebtInput {
  /** A tool actually wrote/edited code this session (the debt is meaningless with no fresh code). */
  readonly freshCodeWritten: boolean;
  /** `projectRequirementFitness(...).unverifiedMustAtoms.length`. */
  readonly unverifiedMustCount: number;
  /** Did ANY verification pass reach the `requirements` rung or above? */
  readonly reachedRequirementsVerify: boolean;
}

/**
 * Pure projection, sibling to `projectReviewDebt`: does the current tape state
 * carry requirement-verification debt — fresh code written AND at least one
 * `must`-modality atom still `unverified`? This is the "green below the
 * requirements rung" pressure the review-debt marker cannot express: review debt
 * fires only AFTER a `requirements`+ pass (it asks "was that pass independently
 * reviewed?"), so a session that terminates on an `artifact`-level green —
 * never climbing to a requirements verify — leaves review debt at `false` while
 * its `must` requirements were never graded. This projection names that gap.
 * Advisory only: it changes no receipt and gates nothing (axiom 18).
 */
export function projectUnverifiedRequirementDebt(
  input: UnverifiedRequirementDebtInput,
): UnverifiedRequirementDebt {
  if (!input.freshCodeWritten || input.unverifiedMustCount <= 0) {
    return { debt: false, unverifiedMustCount: input.unverifiedMustCount, reason: null };
  }
  return {
    debt: true,
    unverifiedMustCount: input.unverifiedMustCount,
    reason: input.reachedRequirementsVerify
      ? "unverified_after_requirements"
      : "ladder_below_requirements",
  };
}
