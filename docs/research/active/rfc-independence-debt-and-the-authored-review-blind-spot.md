# RFC: Independence Debt — Surfacing The Authored-Review Blind Spot At Turn Close

## Metadata

- Status: active
- Kind: RFC (a delegation-activation increment, not a new plane)
- Owner: Runtime, gateway, and delegation maintainers
- Last reviewed: `2026-07-07`
- Depends on:
  - [Candidate Axiom: Authorship Taints Verification](./candidate-axiom-authorship-taints-verification.md)
    (the theory: a producer cannot see what it got wrong; `perspective` is already
    a recorded evidence dimension)
  - [Decision: Delegation Activation Surface And Trigger Economics](../decisions/delegation-activation-surface-and-trigger-economics.md)
    (the baseline this increments — Levers 1–6, the render-time advisory)
  - [Decision: Requirement Fitness And Independent Review](../decisions/requirement-fitness-and-independent-review.md)
    (the graded-evidence surface this reuses — `perspective`, `unverifiedMustAtoms`,
    risk-class floor)
  - [Design Axioms](../../architecture/design-axioms.md) (axiom 1 `Attention belongs
to the model`, axiom 3 `Subtraction beats switches`, axiom 7 `Inconclusive is
honest governance`, axiom 18 `Descriptive metadata derives views, never
authority`)
- Promotion target:
  - `docs/research/decisions/` (an ADR once a second eval round shows the
    channel converges the behavior)
  - `docs/guide/orchestration.md` (the independence-debt reason on the advisory)
  - `docs/reference/tools/delegation.md` (the evidence-gap trigger, once landed)

## Problem Statement

Delegation activation was built to make a capable model _reach for_ delegation on
multi-slice work — above all, reach for an independent fresh-context reviewer that
does the adversarial read the author cannot do on itself. Across real eval rounds
the reaching is not stable:

- **game_4** (same macOS Fn-dictation greenfield task): the model delegated three
  subagents, including an independent reviewer that caught a _critical_ Fn-release
  bug in the generated code. The review's lifecycle was mis-reported (a separate,
  now-fixed bug), but the review itself was high quality.
- **game_5** (near-identical task, on a build with all of that fixed): the model
  delegated **zero** subagents. It wrote and self-verified entirely in-context
  (`verification.outcome.recorded` with `perspective: authored`, `pass`, and **6
  `unverifiedMustAtoms`**). Two critical defects shipped un-caught — a missing
  event-tap re-arm (`tapDisabledByTimeout/ByUserInput`) and no Accessibility
  permission handling at all — and the graded quality regressed from 6.85 to 6.28.

The `review`/`verifier` skills were rendered and available both rounds. Levers 1–6
(operating-contract doctrine, render-time advisory, skill nudges, the reporting
tool) are all **soft, opt-in** signals; the model can and did opt out. The failure
mode is exactly the one the `authorship-taints-verification` candidate axiom names:
the author "verified what it remembered intending, not what it actually wrote — it
grepped for the guard it added and never for the thing it could not see it got
wrong."

The naïve response — turn the activation signal _up_ (a firmer doctrine, more
advisory) — is the wrong lever. This RFC argues, from a control-systems reading of
the observed instability, that the missing piece is not signal strength but an
**information channel**, and proposes the smallest one that fits the axioms.

## Cybernetic Diagnosis: This Is A Control-Capability Gap, Not Noise

Framed as possibility-space control (the discipline of _Control Theory and the
Methodology of Science_):

- **Possibility space + target.** On a greenfield task the model's behavior space
  contains `{self-review in-context, obtain an independent read}`. The target
  sub-space is "an independent adversarial read of the artifact happened." Levers
  1–6 are the _conditions_ meant to steer the model into that branch.
- **Control capability (M/m).** Every lever is advisory. They raise the
  _probability_ of delegating a notch but do not shrink the possibility space onto
  "independent read necessarily happened" — `M/m ≈ 1.x`, not a large number. The
  output variance itself is the proof: game_4 delegated, game_5 did not, so the
  post-control space is still wide enough to contain "no independent read." **This
  is not random noise; it is a control capability that is structurally too small**
  — and axioms 1 and 3 deliberately forbid the most direct fix (a stronger tool / a
  hard switch).
- **Information (the actual bottleneck).** The book's first principle: _you cannot
  control what you cannot adequately perceive_ (blood pressure becomes controllable
  only once a channel makes it visible — biofeedback). At turn close game_5's model
  perceived only its own `authored pass`; it had **no channel telling it that its
  self-review has a systematic blind spot** on exactly the implicit robustness /
  permission requirements it missed. Its "pass" was a **false error signal** —
  negative-feedback failure condition #5 (the measured error does not reflect
  distance to the goal) compounded by condition #1 (the variable "I have an
  un-reviewed blind spot" is outside its observable set).

So activation keeps making the _steering signal louder_ when the defect is a
_missing sensor_. The fix the book points to is not "push harder" but "make the
invisible visible."

Crucially, the sensor data **already exists in the tape and is simply not looped
back to the decision point**: game_5's own `verification.outcome` carried
`perspective: authored` and 6 `unverifiedMustAtoms`. The evidence gap is recorded;
it is just never surfaced where the model decides whether to seek an independent
read.

## The Design: `independence debt` As An Information Channel

Define **independence debt** as a derived, read-only view over evidence the runtime
already records:

> An atom carries independence debt when a **must-have** requirement of a
> runtime/security-class (high) risk floor has **no independent or deterministic
> pass at that risk floor's grade** — the atom is unchecked, author-claimed, or
> checked only sub-floor (even a sub-floor _independent_ presence re-grep cannot
> clear a runtime/security failure mode), so an independent read **at grade** is
> still owed.

The "at grade" clause is load-bearing and was sharpened by the first independent
review of this very RFC: an earlier draft said "authored-only, no independent
receipt", but a runtime atom CAN hold a sub-floor independent presence receipt and
still owe an at-grade read — so the surface must never claim "no independent
receipt". (That the author's own prose diverged from the author's own
implementation, and an independent reviewer caught it, is this RFC's thesis in
miniature.)

This is not new evidence and not a new gate. It is a projection the
`requirement-fitness-and-independent-review` decision already ships:
`FitnessProjection.independenceDebtAtoms` — the high-risk `must` atoms whose state
never reached `satisfied` (no at-grade independent OR deterministic pass bears on
them). It reuses the exact risk-class floor (`MIN_EVIDENCE_KIND_BY_RISK`) and the
grade/perspective axes already recorded; the fitness projection is the single home,
so there is no separate debt-summary layer to keep in sync.

At the turn-close decision point (the same render seam Lever 2's advisory already
occupies), when independence debt is non-empty, surface it as **information, not a
directive**:

> Evidence state: N must-have high-risk atoms have no independent read **at the
> required grade** — [list the atoms]. An independent perspective is the
> verification that parallelizes.

The model then decides — under axiom 1 — how to discharge it. The target is
deliberately a **range, not a point** (the book's "hunter's wide net vs. the small
circle": do not collapse the goal onto the single act "delegate a subagent"). Any of
these closes the debt:

- delegate a fresh-context `review_request` (the heavyweight, highest-independence
  option);
- run a fresh-context self-review that clears the authoring context and reloads a
  reviewer lens (lighter; still `independence_basis: fresh_context` even at
  `different_model: false`);
- add behavioral/`static_guard`-grade deterministic evidence at the atom's risk
  floor.

The channel does not care which — it only makes the gap visible and lets the debt
show as _discharged_ once an at-grade independent OR deterministic pass lands on the
atom.

## Axiom Alignment

- **Axiom 1 (`Attention belongs to the model`).** The channel hands the model a fact
  about its own evidence and returns the decision to it. It never delegates _for_ the
  model, never forces a `review_request`. It is a sensor, not a hand on the wheel.
- **Axiom 3 (`Subtraction beats switches`).** No new config, no new toggle, no new
  delegation primitive. It is a projection over evidence the runtime already commits,
  rendered on a seam the advisory already owns. If anything it _subtracts_ the
  temptation to keep escalating doctrine.
- **Axiom 7 (`Inconclusive is honest governance`).** An authored-only must-atom is
  already at most `likelySatisfied`, never `satisfied`. Independence debt is the
  render-time expression of that honesty — it shows the model the same inconclusive
  state the fitness projection already grades, at the moment the model can act on it.
- **Axiom 18 (`Descriptive metadata derives views, never authority`).** `perspective`
  and risk-class are descriptive; independence debt derives a _view_ from them and
  drives **no gate**. The sole blocking path stays the operator-promoted
  verification-gate manifest. This is the same boundary Lever 2's advisory already
  respects.

## Relationship To Existing Mechanisms (No New Plane)

- **Theory:** this is the second-ring instance the `authorship-taints-verification`
  candidate axiom is waiting on — the first ring recorded perspective; this ring
  _acts on_ the recorded gap. (Whether it counts toward that axiom's promotion, or is
  merely the same ring deepened, is an Open Question below.)
- **Baseline:** it is a delegation-activation increment. Lever 2 today renders a
  pressure-relief / review-debt advisory; independence debt is the **evidence-driven
  third reason** on that same advisory, or a refinement of it — surfaced by graded
  evidence rather than by tape-derived review debt.
- **Evidence source:** it reuses `requirement-fitness`'s graded evidence wholesale.
  It invents no receipt kind and mints no new authority.

## Decision Options

### Option A — Independence-debt information channel at turn close (recommended)

Surface the high-risk unmet-`must` gap (no at-grade independent read) as advisory
information on the existing render seam; let the model discharge it any way that
lands an at-grade independent or deterministic pass. Smallest mechanism that closes
the sensor gap; axiom-clean; reuses shipped evidence.

### Option B — Strengthen the activation signal (rejected)

A firmer doctrine line, a louder advisory, a higher salience nudge. Rejected on the
diagnosis: the bottleneck is a missing sensor, not a weak signal. The book's warning
against "push harder when it won't move" applies directly; louder doctrine also risks
crowding model attention (axiom 1) with diminishing returns.

### Option C — Make independent review mandatory past a risk threshold (rejected)

A gate: block turn close while high-risk must-atoms lack an at-grade independent read.
Rejected on axioms 1 and 3 (it is a hand on the wheel and a switch) and on axiom 18
(a descriptive gap must not become a blocking authority). The operator-promoted
verification-gate manifest remains the _only_ place that may block, by design.

## Landing Plan (Sketch, Not A Commitment)

1. **Projection.** Add `independenceDebtAtoms` to the requirement-fitness projection
   (`FitnessProjection`): must-have, high-risk-class-floor atoms whose state never
   reached `satisfied` (no at-grade independent OR deterministic pass). The fitness
   projection is ALREADY the single shared tape-derived read, so it is the single
   home — no separate `buildIndependenceDebt` layer to keep in sync — consumed
   directly by render and reporting. Orthogonal to `insufficientGradeAtoms` (the
   grade axis); an atom may legitimately sit in both, and consumers must not
   double-count it.
2. **Render.** Extend Lever 2's render-time advisory with an `independence_debt`
   reason keyed like the existing cadence reasons; suppression follows the same
   safe-direction rule as the parallel gate.
3. **Discharge signal.** The debt reads as _cleared_ for an atom the moment an
   at-grade `independent` OR `deterministic` pass binds to it (the atom reaches
   `satisfied`) — no new event, just the join the projection already does.
4. **Instrument.** Extend `report:delegation-evidence` (Lever 6) with an
   independence-debt `open` counter — high-risk must-atoms carried into session close
   still owing an at-grade independent read — on both the per-session report and the
   aggregate, so the channel's effect is measurable before promotion. This is the
   activation counter-signal, read the same way as the existing `failureRate`. A
   precise _discharged-by_ counter (debts closed within the turn) is a deliberate
   follow-up: it needs per-turn fitness history the per-session report does not
   retain, whereas `open` is a single re-derivation of the projection at tape end.

## Source Anchors

- `verification.outcome.recorded` — `perspective`, `unverifiedMustAtoms` (the raw
  sensor data, already committed).
- `requirement-fitness` projection — risk-class floor and must-have flags.
- Lever 2 render seam — `renderDelegationAdvisorySection` and the cadence tracker.
- `report:delegation-evidence` — the instrument (Lever 6).

## Validation Signals

- **Convergence:** independent-read rate across eval rounds tightens (the game*4↔game_5
  3→0 swing narrows) — the point is \_variance reduction*, not maximizing delegation.
- **Coverage:** the fraction of high-risk must-atoms that reach turn close with an
  independent receipt rises.
- **Quality:** the eval regression driver (critical defects that slip past an
  authored-only close, e.g. the tap-rearm / Accessibility class) drops.
- **Non-goal guardrail:** delegation count does _not_ become the metric — a
  fresh-context self-review or a behavioral receipt that discharges the debt is a
  success, not a miss.

## Promotion Criteria And Destination Docs

Promote to `docs/research/decisions/` (and thread the contract into
`docs/guide/orchestration.md` + `docs/reference/tools/delegation.md`) when:

- at least one further eval round shows a high-risk authored-only close either
  discharged into an independent read or explicitly, visibly retained — i.e. the
  channel changed the decision, it was not inert;
- the advisory holds the five delegation-activation invariants (0 runtime decision
  points, no-auto-apply intact, advisory gateless + suppression safe-direction,
  single-homed projection, no contradiction with doctrine);
- `report:delegation-evidence` surfaces the independence-debt `open` count so a
  round's carried-into-close debt is measurable across eval runs (the discharged
  split is a follow-up, not a promotion blocker).

## Open Questions

1. **One ring or two?** Does acting on the recorded gap count as the _second ring_
   the `authorship-taints-verification` candidate axiom needs for promotion, or is it
   the same verify/review ring deepened (leaving tool-effect attestation / repository
   governance as the true second ring)? This RFC assumes the conservative reading:
   same ring, deepened.
2. **Threshold + salience.** How many high-risk unmet `must` atoms should the channel
   surface, and where does it sit in the advisory's salience order relative to the
   requirement-debt reason (the review-debt overlap is resolved in Q3)? Over-surfacing
   re-introduces the attention cost axiom 1 warns against. Current answer: all of them,
   lowest salience — the delegation section demotes first under budget.
3. **Reason unification — RESOLVED (fold), by this feature's own independent review.**
   independence debt is the finer, atom-named form of "an independent read is owed", so
   the render now FOLDS the coarser tape-derived review-debt line whenever independence
   debt is live — the two never render the same ask twice. (The stub already led with
   independence; folding the line too removes the odd "two asks at full, one when
   demoted" shape. axiom 1: same-ask duplication is an attention tax.) pressure-relief
   stays a separate reason (an orthogonal economic ask), and review-debt still fires
   ALONE when independence debt is absent (low-risk work), so no coverage is lost. A
   low, near-monotone cadence-alternation caveat is noted in the code.
4. **Fresh-context self-review as first-class discharge.** Does the runtime already
   let an author clear its own context and re-enter as `fresh_context` without a full
   subagent, and should that be the _default_ lightweight discharge the channel points
   at?

## Related Work

- [Candidate Axiom: Authorship Taints Verification](./candidate-axiom-authorship-taints-verification.md)
- [Decision: Delegation Activation Surface And Trigger Economics](../decisions/delegation-activation-surface-and-trigger-economics.md)
- [Decision: Requirement Fitness And Independent Review](../decisions/requirement-fitness-and-independent-review.md)
- The producer-wiring companion rule (`Surfaces ship with producers`):
  `skills/project/shared/critical-rules.md`.
