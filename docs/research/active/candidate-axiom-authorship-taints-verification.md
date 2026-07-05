# Candidate Axiom: Authorship Taints Verification

## Metadata

- Status: active
- Kind: candidate axiom proposal (not yet a constitutional axiom)
- Owner: Runtime and architecture maintainers
- Last reviewed: `2026-07-05`
- Depends on:
  - [Design Axioms](../../architecture/design-axioms.md) (extends axiom 11
    `Same evidence is not shared authority`; complements 5, 7, 18)
  - [Decision: Requirement Fitness And Independent Review](../decisions/requirement-fitness-and-independent-review.md)
    (the first instance)
- Promotion target:
  - `docs/architecture/design-axioms.md` (a new axiom plus its implementation reading)
  - `docs/reference/axiom-enforcement.md` (regenerated; this axiom starts as
    visible negative space)

## Why This Rises To An Axiom

Three controlled builds of the same app produced the same shape: every process
metric improved while the hardest semantic defect survived or regressed. The
author verified what it remembered intending, not what it actually wrote — it
grepped for the guard it added and never for the thing it could not see it got
wrong. This is model-agnostic; the same-context reviewer inherits the same blind
spots. The mechanisms the intent-realization loop built (perspective-tagged
evidence, an independent `review_request`, the `independenceBasis[]` set) are the
surface. The essence underneath is a single hard fact:

> Self-verification and independent review are different epistemic acts, and a
> receipt that does not record which one produced it silently launders the first
> as the second.

Brewva has the same shape wherever a producer also judges its own work: a model
that both writes and "verifies," a tool that both acts and attests. Folding
review into verify — one receipt kind for both — is how a confirmation-biased
pass reads as trustworthy evidence.

## The Candidate Axiom

> `Authorship taints verification — self-verification and independent review are
different receipt kinds.`

Implementation-grade reading (each clause is a borrowed principle, not a borrowed
mechanism):

1. `Perspective is a dimension of evidence, not a boolean and not a workflow.`
   A receipt records whether it is `authored` or `independent`; the two are never
   interchangeable and never render identically on a Work Card.
2. `Independence is composed, not asserted.` An `independent` receipt carries a
   non-empty `independenceBasis[]` drawn from orthogonal, co-occurring facts
   (`fresh_context`, `different_model`, `preloaded_lens`, `human`,
   `deterministic_adapter`) — a basis set, not a hierarchy, because a same-model
   fresh-context review and a human review must not read as the same thing.
3. `A producer may not certify itself independent.` The structural guarantee, not
   a policy: the authoring path exposes no perspective input, so the only producer
   of an `independent` receipt is a fresh-context reviewer. Self-attestation is
   impossible by construction, not forbidden by rule.
4. `Independence is the verification that parallelizes.` A review needs the diff
   and the atoms, not the author's context, so it overlaps other work — anchored
   to a snapshot `targetRef` so a finding binds to exactly what was reviewed and
   ages to stale when the tree moves past it.

Aesthetic / cross-cutting grammar (for `design-axioms.md`, in the lineage of
`Same evidence is not shared authority`):

> `Evidence carries perspective; authorship it cannot see it cannot check.`

## Relationship To Existing Axioms

- **Extends axiom 11** (`Same evidence is not shared authority`): 11 separates
  authority surfaces that converge on shared evidence; this axiom adds that the
  _evidence itself_ is not shared across the author/reviewer boundary — an
  authored receipt and an independent one are different kinds even when they
  describe the same artifact.
- **Complements axiom 5** (`Every commitment has a receipt`): perspective and
  `independenceBasis[]` are receipt-shaped, so who-checked-what stays inspectable
  after the turn.
- **Complements axiom 7** (`Inconclusive is honest governance`): an atom with only
  authored coverage reads as at most `likelySatisfied`, never `satisfied` — thin
  perspective weakens the claim rather than fabricating certainty.
- **Bounded by axiom 18** (`Descriptive metadata derives views, never authority`):
  the perspective tag drives no gate; it grades and renders evidence, and the sole
  blocking path stays the operator-promoted verification-gate manifest.

## First Instance: The Intent-Realization Loop

The just-landed requirement-fitness / independent-review work is the first
concrete instance, and reading it against the four clauses shows both what it
proves and what it leaves open:

- Clause 1 (dimension): `verification.outcome.recorded` gains `perspective`, and
  the fitness projection treats an author-claimed atom as at most
  `likelySatisfied` — perspective is a first-class evidence axis.
- Clause 2 (composed independence): `review_request` records
  `independenceBasis[]` (`fresh_context` always, `preloaded_lens` when a lens was
  supplied, `different_model` only when the routed model honestly differs).
- Clause 3 (no self-certification): `verification_record` has no perspective
  parameter — the guarantee is structural.
- Clause 4 (parallel, snapshot-anchored): the observer-committed `review_request`
  runs concurrently with authored work, its findings bound to a snapshot
  `targetRef` that the debt/fitness joins downgrade to stale when the tree moves.

So the instance is real but single-ring: it exercises the discipline entirely
within the verify/review domain. That it holds there without leaking authority is
the evidence; a second ring is what makes it constitutional.

## Negative Space (Where The Axiom Is Currently Unenforced)

Each is a place where a producer also judges its own output, and where the same
perspective-as-evidence method would apply — surfaced here the way
`axiom-enforcement.md` surfaces unenforced axioms:

- **Tool self-attestation**: a tool that both mutates the world and reports
  success attests its own effect; the effect receipt has no perspective on
  whether an independent check confirmed it.
- **Compaction / summary fidelity**: the summarizer judges its own summary;
  whether an independent read confirms the summary preserved what mattered is
  unrecorded.
- **Repository governance**: merge/release trust reads authored CI signal;
  independent-review perspective on the change is not yet a distinct receipt kind
  the governance authority consumes.

## Promotion Criteria

Promote into `docs/architecture/design-axioms.md` (and regenerate
`axiom-enforcement.md`) when the discipline has earned constitutional weight:

- at least two instances across **distinct rings** (verify/review is one; a second
  — tool-effect attestation or repository governance — is the threshold), so the
  axiom is proven cross-cutting rather than a single-feature rationalization;
- the implementation reading survives review against the existing axioms without
  collapsing into axiom 11;
- the regenerated `axiom-enforcement.md` can name which rules enforce it and which
  surfaces remain negative space.

Until then this stays a candidate: a named discipline with one single-ring
instance, not yet a line in the constitution.

## Related Work

- The first instance: requirement-fitness-and-independent-review decision record.
- The producer-wiring companion rule (`Surfaces ship with producers`):
  `skills/project/shared/critical-rules.md`.
- Axiom-to-rule enforcement and negative-space surfacing:
  `axiom-negative-space-and-decisions-demotion.md`.
