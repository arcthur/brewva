# Candidate Axiom: Accounting For Unmeasurable Benefit

## Metadata

- Status: active
- Kind: candidate axiom proposal (not yet a constitutional axiom)
- Owner: Runtime and architecture maintainers
- Last reviewed: `2026-06-26`
- Depends on:
  - [Design Axioms](../../architecture/design-axioms.md) (extends axiom 7
    `Inconclusive is honest governance`; complements 1, 5, 10)
  - [RFC: Quantified Compaction Economics And Graded Evidence Honesty](./rfc-quantified-compaction-economics-and-evidence-honesty.md)
    (the first instance)
- Promotion target:
  - `docs/architecture/design-axioms.md` (a new axiom plus its implementation reading)
  - `docs/reference/axiom-enforcement.md` (regenerated; this axiom starts as
    visible negative space)

## Why This Rises To An Axiom

Distilling `headroom` produced a list of mechanisms (a net-cost formula, reversible
references, waste signals, a three-tier savings honesty model). That list is the
surface. The essence underneath is a single hard problem `headroom` is built to
solve: **its core value — saved tokens — can never be directly observed.** You
cannot see what a turn _would have_ cost without compression; the benefit is a
counterfactual. Every `headroom` mechanism is a consequence of one question:

> How does a system stay trustworthy about a benefit it cannot directly measure?

Brewva has the same shape everywhere it claims a benefit it cannot observe: did a
compaction actually help, did a recall hit, did an injected skill get adopted, did
cost governance save anything. Today each is asserted or left implicit. This note
proposes the methodology as a constitutional discipline rather than a per-feature
trick, under the discipline of borrowing the method, never `headroom`'s authority
shape (the proxy that seizes attention — rejected by axioms 1 and 4).

## The Candidate Axiom

> `Unmeasurable benefit must be accounted, not asserted.`

Implementation-grade reading (each clause is a borrowed principle, not a borrowed
mechanism):

1. `Reversible action licenses aggression.` A lossy or aggressive move toward an
   unmeasurable benefit is admissible only where it is reversible. (`headroom`
   needs CCR side-caches to earn this; Brewva gets it from tape — but the licence
   is the point, not the cache.)
2. `A decision unobserved in its consequence is a guess.` Every benefit-claiming
   decision must be instrumented so its consequence becomes evidence, and that
   evidence must feed the next decision. The unit of intelligence is the closed
   loop, not the one-shot.
3. `One currency makes trade-offs compose.` Denominate competing benefits in a
   single quantity so net value can be added, compared, and reasoned about, rather
   than arbitrated by a pile of independent heuristics.
4. `Uncertainty weakens the claim, not the operation.` Under thin evidence the
   system keeps functioning but grades its assertion (`measured` / `estimated` /
   `inconclusive`) — it never fabricates certainty and never stalls. (This is
   axiom 7 made constructive and made the default shape of all benefit evidence.)
5. `Calibration beats upfront correctness.` A long-lived system's value is in the
   loop that compares prediction to observed consequence and converges, not in
   being right on day one. A migration that changes a claimed benefit is gated on
   that comparison, by design.

Aesthetic / cross-cutting grammar (for `design-axioms.md`, in the lineage of
`Model-sovereign, tape-accountable context`):

> `Account the unmeasurable; grade the claim; calibrate, don't assert.`

## Relationship To Existing Axioms

- **Extends axiom 7** (`Inconclusive is honest governance`): 7 grants permission to
  say "not enough evidence"; this axiom adds the constructive method for the whole
  benefit surface (account, grade, calibrate, reverse).
- **Complements axiom 1** (`Attention belongs to the model`): the reversible-action
  clause is what keeps benefit-seeking from sliding into runtime-owned attention —
  the runtime may account and grade evidence, but acting on it stays the model's.
- **Complements axiom 5** (`Every commitment has a receipt`) and **axiom 10**
  (`Recovery is model-native`): graded benefit evidence is receipt-shaped, and the
  calibration loop is model-native review, not kernel choreography.

## First Instance: Quantified Compaction Economics

The just-landed compaction-economics work is the first concrete instance, and
reading it against the five clauses shows both what it proves and what it leaves
open:

- Clause 3 (currency): `netReuseValue` mints the first common-currency figure —
  competing compaction trade-offs become one signed token-equivalent number.
- Clause 4 (graded claim): the `measured` / `estimated` / `inconclusive` grade,
  joined per-verdict to a real `provider_cache_observation`, is the honesty grade
  made literal on every economic verdict.
- Clause 2 (closed loop): the grade _is_ the loop — a prediction (`estimated`)
  becomes `measured` only when a later observation confirms it.
- Clause 5 (calibration): the Phase-3 `wasteful` redefinition is gated on a
  real-trace calibration against the old heuristic — the loop, not a one-shot edit.
- Clause 1 (reversible action): **untouched.** The economics are read-only
  evidence; they license no action, so the aggression-needs-reversibility clause is
  unexercised here.

So the instance is real but partial: it exercises currency, grading, loop, and
calibration in _one_ ring (context/compaction) and does not exercise reversible
action at all. That partiality is the signal that this is an axiom, not a feature —
one feature cannot discharge a cross-cutting discipline.

## Second Instance: Self-Eval And The Calibration Registry (Harness-Improvement Ring)

The optimizer-last-hop Phases 2 + 3 SCAFFOLD a second instance, in a distinct
ring — the harness-improvement loop, not context/compaction. Read honestly against
the five clauses, the instrument is built but NOT YET exercised:

- Clause 3 (currency): PARTIAL, and it fits worse than the first instance.
  `report:self-eval` yields a repeatable, tape-derived outcome PROFILE (distinct
  tools, per-family exercise, terminal outcome) — the common face that makes "did
  this harness change help" checkable, but NOT a single composable scalar like
  `netReuseValue`. A profile does not net into one comparable number, so the
  "one currency, trade-offs compose" clause is only approximated here.
- Clause 4 (graded claim): the registry status
  (`asserted` / `calibrated(date, corpus)` / `contested`) is the honesty grade
  made literal — but present only as a TYPE: all 12 parameters are currently
  `asserted`, none `calibrated`, because no corpus has graded one. The clause is
  scaffolded, not exercised; the uniform `asserted` column IS the proof the
  grading has not yet run.
- Clause 2 (closed loop): the calibration-report cycle is WIRED to ingest
  self-eval and name the registry statuses; a parameter would move `asserted` →
  `calibrated` only when a corpus grades it — but no corpus has run, so the loop
  is built, not yet turned.
- Clause 5 (calibration): the registry NAMES the calibration-eligible surface and
  values change solely as reviewed code, gated on evidence, never auto-tuned — the
  one clause the arc does deliver today.
- Clause 1 (reversible action): **untouched here too.** Self-eval and the registry
  are read-only evidence and legibility; they license no action.

So the second instance is scaffolding-complete but EVIDENCE-EMPTY: the instrument
to account harness benefit exists and is wired into one loop, but it has scored
and graded nothing yet. Honest bookkeeping — it is SUBMITTED as second-ring
evidence, not a satisfied second instance; the distinct-rings bar clears on the
first exercised grading, not on the scaffold. (Both instances also leave reversible
action untouched.)

## Negative Space (Where The Axiom Is Currently Unenforced)

Each is a benefit Brewva claims but cannot directly observe, and where the same
account/grade/calibrate method would apply — surfaced here the way
`axiom-enforcement.md` surfaces unenforced axioms:

- **Attention selection**: did a retained/evicted entry actually help the turn?
  (Feeds the attention RFC's retention evidence rather than adding a new surface.)
- **Recovery**: did a recovery actually restore correct state, graded by observed
  post-recovery behavior, not asserted on completion.
- **Cost governance**: the same measured-vs-estimated honesty the savings ledger
  needs (`getIntegrity()` is still a stub) — denominated, graded, calibrated.
- **Skill effectiveness**: an injected skill claims a benefit; was it adopted?
  (The skill-selection trace is the instrument; the loop is unbuilt.)

## Promotion Criteria

Promote into `docs/architecture/design-axioms.md` (and regenerate
`axiom-enforcement.md`) when the discipline has earned constitutional weight:

- at least two instances across **distinct rings** where the discipline is
  EXERCISED, not merely scaffolded. First (compaction economics, context ring):
  exercised — `netReuseValue` composes and a grade has flipped `estimated` →
  `measured`. Second (self-eval + the registry, harness-improvement ring):
  scaffolded but NOT yet exercised — 0 corpus runs, all 12 parameters `asserted`.
  So the second is SUBMITTED as evidence; the bar clears on the first exercised
  grading, not the scaffold;
- the implementation reading survives review against the existing axioms without
  collapsing into axiom 7;
- the regenerated `axiom-enforcement.md` can name which rules enforce it and which
  surfaces remain negative space.

The second ring is scaffolded and submitted as evidence, but the bar is NOT yet
cleared: it clears on the first EXERCISED grading in that ring — a corpus run that
moves a parameter off `asserted` — then the review reading (does it survive without
collapsing into axiom 7?) and a regenerated `axiom-enforcement.md`. Until then this
stays a candidate — a named discipline with one exercised instance and one
scaffolded-but-unexercised second, not yet a line in the constitution.

## Related Work

- The first instance and its grammar: quantified-compaction-economics RFC.
- Axiom-to-rule enforcement and negative-space surfacing:
  `axiom-negative-space-and-decisions-demotion.md`.
- The borrowing discipline (`Borrow the mechanism, never the authority shape`):
  checked-invariants RFC.
- Accepted aesthetic this extends: `Model-sovereign, tape-accountable context`.
