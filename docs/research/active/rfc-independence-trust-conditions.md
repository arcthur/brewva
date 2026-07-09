# RFC: Independence Trust Conditions After The Grade-Ceiling Subtraction

## Metadata

- Status: active
- Kind: RFC (a verification-doctrine increment on the subtracted harness, not a new plane)
- Owner: Runtime, vocabulary, and delegation maintainers
- Last reviewed: `2026-07-09`
- Promotion target:
  - `docs/research/decisions/` (an ADR once the mirror rule lands and a tape replay
    or eval round shows a stale independent CLEAR aging out — debt re-lights —
    with no false `satisfied` surviving edits)
  - `docs/journeys/operator/verification-and-independent-review.md` (the trust-conditions
    inventory and the deterministic-evidence reintroduction bar)
- Depends on:
  - [Decision: Harness Subtraction Of Trap Library, Static-Guard Grade Ceiling, And Independence-Debt Census](../decisions/harness-subtraction-trap-static-guard-grade-ceiling.md)
    — the subtraction this RFC completes the forward half of
  - [Decision: Boundary-First Subtraction and Model-Native Recovery](../decisions/boundary-first-subtraction-and-model-native-recovery.md)
    — the constitutional frame (complexity tracks boundaries, not model compensation)

## Problem Statement

The 2026-07-09 subtraction (`9f6db9b`) removed the trap library, the static-guard
6-lens producer, the evidence grade axis, and the `MIN_EVIDENCE_KIND_BY_RISK`
grade ceiling. Its ADR records WHAT was removed and why the removed machinery was
overfit. Two questions the ADR deliberately did not answer are this RFC's scope:

1. **What now governs the affirmative independent path?** With the ceiling gone,
   an independent review's CLEAR genuinely discharges a high-risk atom. The trust
   this places in the reviewer is mostly earned STRUCTURALLY (see Current
   Guards), but one asymmetry the ceiling used to mask is now live: **a stale
   CLEAR still satisfies.** Findings age out when the tree they reviewed changes;
   passes never do.
2. **Under what conditions may deterministic evidence ever return?** The
   `EvidenceItem` channel was retained as producerless plumbing. Without a
   pinned reintroduction bar, the next recurring defect invites the next regex
   lens — the exact heuristic-accretion failure mode the subtraction corrected.

## The Re-Evaluation, Recorded

The grade ceiling was a category error in what it demanded, not in what it
feared. The fear was sound and survives as doctrine: _authorship taints
verification_ — an author self-claim on a `runtime`/`security` atom is the
weakest possible basis, so such an atom owes a read the authoring stream cannot
mint on its own work. The error was binding that owed read to **determinism**
(a regex predicate over source text) when the property actually owed is
**independence** (a fresh perspective that genuinely inspected the
implementation). Consequences, in the order the eval series exposed them:

- The only at-grade producer was six macOS-app regexes that no-op on brewva's
  own TypeScript, so in headless self-development the census sat permanently
  `open` — noise wearing the uniform of honest inconclusive.
- A capable independent reviewer — the general mechanism — was architecturally
  capped at `likelySatisfied` on exactly the atoms that owed it (the ceiling),
  while the special-case regex held the only key.
- The regexes both under-covered and mis-judged. game_9_1's Fn suppression is
  correctly scoped by flag-state transition with no `keyCode` token; the
  keycode lens would have judged that correct code FAIL, and a reviewer that
  reasons about the implementation judges it correctly. Token-shaped predicates
  also exert Goodhart pressure: the cheapest way to satisfy them is to write
  the token, not the property.
- The capability slope runs the wrong way for heuristics: a reasoned
  independent review strengthens as models strengthen; a frozen regex set does
  not. A harness that optimizes the machine-that-produces-answers places its
  trust where capability compounds and keeps only mechanisms that are true of
  every repo (harness-engineering thesis: fewer heuristic rules, more general
  mechanisms; the smarter the model, the less the harness should prescribe).

Eval evidence across the series: game_7 — an independent review caught the
recurring Fn-scoping defect and the model fixed it pre-ship (the general
mechanism works end-to-end). game_8 — the review caught it and the model shipped
it anyway (an act-on-review closure gap, since addressed by the retained
`review_closure` advisory; not a review-quality gap). game_9_1 — ran hours after
the subtraction: the silent lenses and unminted trap atoms were the subtraction
working as designed, not sensors failing; the model recorded well-formed atoms
with `observableSignals` and an honest authored `runtime_smoke` receipt whose
`unverifiedMustAtoms` named all seven atoms — the system degraded to honest
inconclusive, never to a false green. The remaining gap there (zero delegation)
is a model-activation question, out of this RFC's scope.

## Current State (post-subtraction, verified against code)

**What discharges.** Any deterministic pass keyed to the atom OR any independent
pass that names it reaches `satisfied`; authored coverage caps at
`likelySatisfied`; no live evidence reads `unverified`
(`packages/brewva-vocabulary/src/internal/fitness.ts` lines 248-270 join rules,
lines 308-327 independent feed). `independenceDebtAtoms` re-anchored grade-free:
a high-risk `must` atom in `unverified`/`likelySatisfied`
(`packages/brewva-vocabulary/src/internal/fitness.ts` lines 203-220, 412-427).

**What already guards the affirmative independent path.** These are structural —
enforced by producers and consumers the model does not control:

- G1 — perspective is producer-keyed. `verification_record`'s parameter schema
  has no perspective field and hard-stamps `authored`
  (`packages/brewva-tools/src/families/workflow/verification-record.ts`
  lines 198-201); only the review-receipt path mints `independent`
  (`packages/brewva-tools/src/families/delegation/review-receipts.ts` line 311).
- G2 — CLEAR-only attestation. A non-pass outcome carries no `atomRefs`,
  enforced at the producer (`review-receipts.ts` lines 291-301) and re-checked
  at the consumer (`packages/brewva-tools/src/runtime-port/verification.ts`
  lines 296-304), so a concern review can never blanket-violate or
  blanket-satisfy.
- G3 — asked-set attestation. The CLEAR's `atomRefs` are copied from the
  DISPATCH's `reviewedAtomIds` (`review-receipts.ts` line 301), which the
  harness sets only for an atoms-target review or a files/session_diff review
  whose target COVERS the fresh-touched universe (the coverage-scoped fold:
  `packages/brewva-tools/src/families/delegation/review-request.ts`
  lines 216, 234; `packages/brewva-tools/src/families/delegation/review-request-packet.ts`
  line 122; `packages/brewva-tools/src/runtime-port/session-touched-files.ts`
  lines 192, 212). A reviewer cannot inflate its own attestation list.
- G4 — attention surfaces. The RuntimeBrief advisory keeps naming open
  independence debt (`packages/brewva-gateway/src/hosted/internal/context/runtime-brief.ts`
  lines 287-341), and act-on-review closure keeps naming live unaddressed
  findings; both advisory-only (axiom 18).

**The one missing guard.** Freshness is asymmetric. A finding whose `targetRef`
no longer matches the tree is dropped whole — STALENESS NEVER VIOLATES
(`fitness.ts` lines 342-353, judged per-finding against its own receipt
timestamp). Independent outcomes are exempt by declared design: "outcomes are
keyed to atoms, not to a tree snapshot, so they are not staleness-checked here
(the caller decides which to feed in)" (`fitness.ts` lines 252-254) — and the
caller feeds every independent receipt unconditionally
(`packages/brewva-tools/src/runtime-port/verification.ts` lines 286-315).

## The Gap: Staleness Never Satisfies

Concrete failure: a covering review CLEARs `req-X` at `t1` (atom → `satisfied`).
At `t2` the model rewrites the attested implementation — perhaps reintroducing
the exact defect class. The atom stays `satisfied`; turn close shows no debt; a
false green ships. Under the grade ceiling this path could not reach a
high-risk atom (the CLEAR was capped anyway), which is why it went unnoticed;
with the ceiling gone it is the live hole in the affirmative half.

The rule this RFC proposes is the mirror of the one findings already obey:

> **STALENESS NEVER SATISFIES.** An independent pass feeds the fitness join only
> while its `targetRef` still matches the tree, judged by the SAME conservative
> tape-only matcher (`reviewTargetRefMatchesTapeOnly`) against the receipt's OWN
> timestamp. A stale pass is dropped whole — its atoms fall back to whatever
> other live evidence says (typically `likelySatisfied` via authored coverage,
> re-lighting independence debt).

This is evidence physics, not a new control: staleness is already load-bearing
for findings (`fitness.ts` lines 342-353) and for review debt
(`projectTapeReviewDebt`); extending it to passes is symmetry, not authority.
The error direction is safe by construction — over-aging a pass RE-OPENS debt
(over-shows; the model re-reviews or re-verifies), whereas the current behavior
under-shows (a false `satisfied`). Note the deliberate contrast with
act-on-review's anchor-scoped freshness: there, whole-snapshot aging CLEARED
pressure wrongly (dangerous direction), so findings needed anchor scoping; here,
whole-`targetRef` aging re-lights pressure (safe direction), so the coarse
matcher is acceptable and per-atom refinement is deferred (Open Question 1).

Implementation shape (deliberately the smallest correct cut): the assembler
already holds `payload.targetRef`, the event timestamp, `appliedPatchSetRefs`,
and `latestTreeMutationAt` in the same scope
(`packages/brewva-tools/src/runtime-port/verification.ts` lines 286-349); the
change is a per-receipt freshness check before pushing to
`independentOutcomes`, mirroring the findings loop. No vocabulary change, no
new event, no model-facing surface.

## The Reintroduction Bar For Deterministic Evidence

The `EvidenceItem` channel stays, producerless
(`packages/brewva-vocabulary/src/internal/iteration.ts` lines 489-501;
claim-time collection is an empty vessel at
`packages/brewva-tools/src/families/workflow/verification-record.ts`
lines 176-183). Any future producer must clear ALL four bars:

1. **Domain-general and boundary-anchored.** True of every repo brewva runs in:
   build/test gate receipts, LSP or typechecker diagnostics, command exit
   classes. Never a domain-specific source matcher — the deleted lenses' class.
   Recurring domain defects belong in EVAL FIXTURES (the game-series prompts
   that measure the loop), not in runtime matchers that steer it.
2. **Deterministic by construction.** The runtime runs the check and records
   the result; a model claim never mints a deterministic item (unchanged
   doctrine).
3. **Attribution declared, never inferred.** An evidence item's effective
   strength is min(verdict strength, attribution strength). The deleted
   producer's terminal defect was keyword-inferred attribution (statement
   routing; then construct-domain routing) — attribution must come from an
   explicit declaration (the atom's own `observableSignals`, a gate manifest
   naming atoms, or empty `atomRefs` carried as an unbound receipt-level
   signal), never from matching prose.
4. **Additive, never a gate.** A deterministic producer may accelerate
   `satisfied` and may convict (`deterministic_conflict`); it must not
   re-introduce a floor that caps what an independent review can discharge. The
   general mechanism stays senior; determinism assists.

## What Remains The Machine

The post-subtraction harness keeps exactly the mechanisms that are (a) true of
any repo, (b) tape-derived, and (c) capability-scaling — the meta-methodology
residue this RFC pins as doctrine:

- requirement atoms with model-declared `riskClass`/`observableSignals`
  (decomposition owned by the model, axiom 1);
- the authored/independent perspective split, structurally keyed to producers
  (G1) — independence is a fact about who ran, not a claim;
- staleness physics over the tape (findings, review debt, and — with this RFC —
  passes), one conservative matcher everywhere;
- attribution by declaration (atomRefs, anchors, asked-set attestation);
- act-on-review closure (self-clearing negative feedback on live findings);
- advisory-only rendering (axiom 18) with the sole gate remaining the
  operator-promoted verification-gate manifest;
- the eval loop itself: same-prompt game-series runs, tape replay, and
  forward-simulation of any new projection over real tapes BEFORE landing —
  the method that caught a shipped-defect-missing BLOCKER in act-on-review and
  the attribution false-positives, and the empirical governor that keeps
  trust-in-the-reviewer honest as models change (a weaker model that skips
  review leaves atoms honestly `unverified`; it cannot fake a green).

## Decision Options

### Option A — Land staleness-never-satisfies + pin the reintroduction bar (recommended)

- Impact: one consumer-side loop change in
  `assembleRequirementFitnessInputFromEvents` + unit/replay tests; this RFC's
  doctrine sections promoted into the verification journey and the subtraction
  ADR's stable docs on acceptance.
- Pros: closes the only identified false-green path in the post-subtraction
  affirmative half; pure symmetry with existing physics; zero new model
  surface; keeps the subtraction honest against its own axiom-7 claim.
- Cons: a covering CLEAR ages on ANY covered-set edit, so discharge is
  short-lived during active development (safe direction; re-verification is the
  honest ask).
- Risks: low — the matcher, timestamps, and inputs are already in scope at the
  change site.

### Option B — Doctrine only (no code change)

- Pros: zero code motion.
- Cons: leaves a stale CLEAR discharging high-risk atoms — a false `satisfied`
  the ADR's own axiom-7 rationale ("honest inconclusive, not a fake pass")
  cannot defend; the gap compounds as reviews become the primary discharge path.

### Option C — Option A plus per-atom attestation anchors now

- Reviewer names, per attested atom, the files it read; passes age per-atom.
- Rejected as premature: adds a model-facing protocol field before any eval
  shows the coarse rule's over-aging costs attention in practice (the same
  restraint that deferred finding-level anchor refinements until game_8 proved
  the need).

## Landing Plan (Sketch, Not A Commitment)

1. S1 — the mirror rule: freshness-gate independent outcomes at the assembler
   (per-receipt own-timestamp, shared matcher); unit tests for
   fresh-pass-discharges / stale-pass-drops / P1-A ordering; replay game_7 and
   game_8 tapes to confirm no regression (both reviews ended FAIL, so no
   existing discharge changes).
2. S2 — docs: promote the reintroduction bar and the trust-conditions inventory
   into `docs/journeys/operator/verification-and-independent-review.md`; cross-note
   the subtraction ADR; keep this RFC active until the eval gate.
3. S3 — eval gate: a future game-series run in which an independent CLEAR lands
   and later edits occur shows the discharge aging out (debt re-lights) instead
   of a frozen `satisfied` — validated by tape replay, not live-run luck.

## Validation Signals

- A stale independent CLEAR contributes nothing: atom falls back to
  authored-only `likelySatisfied` and re-enters `independenceDebtAtoms`.
- A fresh independent CLEAR still discharges immediately (no ceiling
  regression).
- game_7/game_8 tape replays are byte-stable on states (their review outcomes
  were FAIL; `atomRefs` empty by CLEAR-only, so nothing to age).
- No new render surface, no new event kind, no schema change.

## Source Anchors

- `packages/brewva-vocabulary/src/internal/fitness.ts` lines 203-220
  (grade-free high-risk classes), 248-270 (join rules incl. the outcomes
  staleness exemption at 252-254), 308-327 (independent feed → `satisfied`),
  342-353 (STALENESS NEVER VIOLATES for findings), 412-427 (re-anchored
  `independenceDebtAtoms`).
- `packages/brewva-tools/src/runtime-port/verification.ts` lines 286-349 (the
  assembler: unconditional independent feed beside already-derived freshness
  inputs — the change site).
- `packages/brewva-tools/src/families/delegation/review-receipts.ts`
  lines 286-322 (producer-keyed independent perspective, CLEAR-only,
  asked-set `atomRefs`).
- `packages/brewva-tools/src/families/workflow/verification-record.ts`
  lines 176-183 (producerless `evidenceItems` vessel), 198-201 (authored
  hard-stamp).
- `packages/brewva-tools/src/families/delegation/review-request.ts`
  lines 216, 234 and
  `packages/brewva-tools/src/families/delegation/review-request-packet.ts`
  line 122 (the coverage-scoped fold feeding `reviewedAtomIds`).
- `packages/brewva-tools/src/runtime-port/session-touched-files.ts`
  lines 192, 212 (the single covers rule).
- `packages/brewva-vocabulary/src/internal/iteration.ts` lines 489-501
  (`EvidenceItem`, the retained plumbing).

## Open Questions

1. **Per-atom attestation anchors.** Should a reviewer eventually name the
   files it read per attested atom, so passes age per-atom instead of
   per-receipt? Deferred until an eval shows the coarse rule's over-aging is a
   real attention cost (Option C rationale).
2. **Basis tiers.** `independenceBasis` arms are currently uniform
   (`fresh_context`, `different_model`, `preloaded_lens`, `human`,
   `deterministic_adapter`). Should some future surface weight them (e.g.
   different_model > preloaded_lens)? No evidence yet that uniformity misleads;
   revisit only on eval signal.
3. **First legitimate deterministic producer.** The nearest candidate clearing
   all four bars is the verification-gate manifest's command receipts (build/
   test exit classes) minting unbound (`atomRefs: []`) receipt-level items —
   attribution then owed to explicit declaration, not inference. Worth its own
   note when a producer is actually wanted.
4. **Activation remains the binding constraint.** game_9_1's model never
   dispatched a review, so every trust condition here was vacuously idle. The
   delegation-activation question (how a soft, axiom-1-respecting harness gets
   a weaker model to reach for independence at all) is a separate lever and the
   current empirical bottleneck.

## Related Work

- [Decision: Harness Subtraction Of Trap Library, Static-Guard Grade Ceiling, And Independence-Debt Census](../decisions/harness-subtraction-trap-static-guard-grade-ceiling.md)
  — the WHAT; this RFC is the forward WHY-and-WHAT-NEXT.
- [RFC: Review→Atom Attribution And The Grade Ceiling On Discharging Independence Debt](./rfc-review-atom-close-connection.md)
  — superseded-by-subtraction provenance; its coverage-scoped fold survives as
  guard G3, and its min(verdict, attribution) lesson survives as reintroduction
  bar 3.
- [RFC: Independence Debt — Surfacing The Authored-Review Blind Spot At Turn Close](./rfc-independence-debt-and-the-authored-review-blind-spot.md)
  — the sensor's origin; its principle survives grade-free.
- Lilian Weng, "Why We Think About Harness Engineering" (2026-07-04) — the
  meta-methodology frame: heuristics shrink, general mechanisms grow, the
  harness optimizes the answer-producing machine, and stronger models push back
  against harness over-engineering.
