# RFC: A User Model As A Tape-Folded Advisory Projection

## Metadata

- Status: active
- Owner: Recall, substrate-workbench, and vocabulary maintainers
- Last reviewed: `2026-06-26`
- Depends on:
  - [Candidate Axiom: Accounting For Unmeasurable Benefit](./candidate-axiom-accounting-for-unmeasurable-benefit.md)
  - [RFC: Reversible References, Advisory Compression Routing, And Replay-Distilled Precedent](./rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md)
  - [RFC: Recall Next-Turn Cache Warming (Latency, Not Delivery)](./rfc-recall-next-turn-cache-warming.md)
- Promotion target:
  - `docs/reference/runtime.md`
  - `docs/journeys/operator/recall-and-knowledge-compounding.md`

## Problem Statement

Brewva has no durable model of _who the user is_ across sessions — preferences,
role, communication style, standing constraints. Each session rediscovers them.
The peer agent (`hermes`) closes this with a `MemoryProvider` plugin and a
`Honcho` integration that performs _dialectic user modeling_ (multi-pass LLM
reasoning over history to infer a peer representation), injected per turn.

Two parts must be separated. The **discipline** for a benefit you can never
directly observe is already in flight: the candidate axiom _"Unmeasurable benefit
must be accounted, not asserted"_ names exactly the regime a user model lives in
(a claimed-helpful user fact is a counterfactual), and explicitly seeks a _second
distinct ring_ to prove itself beyond compaction economics. A user model is that
second ring. The **mechanism** is residue — no active RFC specifies how user facts
are stored, updated, or surfaced.

The placement is the design problem, and Brewva's axioms decide it against a
literal Honcho port:

- **No second memory store** (a named anti-pattern). A user model must be a
  _projection over the event tape_, rebuildable and never replay truth (axiom 6) —
  not an external DB injected per turn.
- **No auto-injection** (axiom 1). `hermes` injects the peer card into the prompt;
  Brewva surfaces a user model on **explicit pull**, like recall and the workbench.
- **Model-authored, advisory only** (axioms 11, 18). User facts are authored by the
  model into the workbench advisory lane; they grant no capability, route no model,
  and bypass no gate.

The framing line:

> The user model is a projection the model authored and the tape preserved —
> graded, explicit-pull, and authority-free. Brewva folds facts; it does not
> bolt on a second brain.

## Scope Boundaries

In scope:

- a model-authored "user fact" advisory event in `@brewva/brewva-vocabulary`
  (`authority: "advisory"`), carrying the fact, its scope, a confidence/grade, and
  a supersedes pointer for revision
- a deterministic, rebuildable **user-model projection** folding those events
  (latest-wins per fact key, with superseded facts retained for audit) — the same
  projection discipline recall and the work card already follow
- an **explicit-pull** retrieval surface (a recall scope or a sibling tool) that
  returns the current user model; opening it triggers nothing model-visible on its
  own
- an **honesty grade** per fact (`measured` / `estimated` / `inconclusive`),
  applying the candidate axiom's account/grade/calibrate method as its second-ring
  instance — a fact corroborated by later sessions grades up; an asserted-once fact
  stays `estimated`

Out of scope (owned elsewhere; this RFC must not re-open):

- any auto-injection of the user model into the system prompt or user message →
  forbidden by axiom 1 and the projection discipline; retrieval is explicit-pull
- a second persistent memory store / external user-modeling DB → the anti-pattern;
  user facts are tape events, the model is a projection
- LLM _dialectic reasoning_ run by the runtime on a cadence → that is runtime
  spending model thought on the user's behalf (axioms 2, 4). Inference stays
  model-native: the model authors a fact when it concludes one. An optional
  external dialectic service may exist as an advisory enrichment, but stays
  advisory, explicit-pull, and grants nothing (Open Questions)
- promoting the candidate axiom itself → that is the candidate-axiom note's job;
  this RFC is one of its required proving instances, not its promotion
- ranking user facts into attention authority → facts are advisory evidence, not a
  capability or budget grant (axiom 18)

## Peer Lens: What `hermes`'s `MemoryProvider` + `Honcho` Get Right

Verdict vocabulary: **COVERED**, **REJECT**, **BORROW**, **OUT OF SCOPE**.

| `hermes` mechanism                                                         | Verdict             | Rationale / where it lands                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| persistent peer profile built across sessions                              | BORROW              | The capability. In Brewva it is a tape-folded projection of model-authored facts, not an external store.                                                                        |
| `honcho_conclude` persists a durable user fact                             | BORROW              | Maps to a model-authored advisory `user_fact` event; the tape is the durable log, the projection is the read model.                                                             |
| dialectic multi-pass LLM reasoning to _infer_ user traits, run by provider | REJECT (as runtime) | Runtime spending model thought to infer the user is attention/thought-path seizure (axioms 1, 2, 4). Inference is model-native; the model authors a fact when it concludes one. |
| per-turn injection of the peer card into context                           | REJECT              | Auto-injection seizes attention (axiom 1). Brewva surfaces the model on explicit pull.                                                                                          |
| `MemoryProvider` ABC: initialize / prefetch / sync_turn / hooks            | COVERED             | Brewva's recall broker + workbench + projection already provide the lifecycle; a user model is a projection, not a new provider plugin type.                                    |
| one-provider-at-a-time to bound tool-schema bloat                          | COVERED             | A single explicit-pull retrieval surface; no plugin registry needed.                                                                                                            |
| cost-aware cadence knobs (context/dialectic frequency)                     | OUT OF SCOPE        | Only relevant to the rejected per-turn-injection/dialectic-runtime design; an explicit-pull projection has no cadence to tune.                                                  |
| confidence/recency on facts                                                | BORROW              | Becomes the per-fact honesty grade — the candidate axiom's account/grade/calibrate, made literal on a user fact (its second-ring instance).                                     |

The honest residue: a **model-authored advisory `user_fact` event**, a
**rebuildable user-model projection**, an **explicit-pull retrieval surface**, and
a **per-fact honesty grade**. The provider plumbing and the inference engine are
either covered or axiom-rejected.

## Decision Options

### A. Fact ownership (chosen: model-authored advisory event, tape-folded)

A `user_fact` is authored by the model (the workbench/advisory lane already lets
the model record durable advisory material) as a vocabulary event with
`authority: "advisory"`. The tape preserves it; a projection folds it. This reuses
the exact mechanism the reversible-references RFC settled for the
"recall-versus-summary fact-ownership" question — the model owns the fact, the tape
owns its persistence, a projection owns its read view. No new ownership category.

### B. Projection shape (chosen: latest-wins with retained supersession)

The user-model projection keys facts by `(scope, factKey)`, latest-wins, with a
`supersedes` chain so a revised preference does not erase its history (audit and
calibration both need the prior). It is deterministic from the events, rebuildable,
and never replay truth — losing it changes diagnostics only, exactly like the
session index.

### C. Retrieval (chosen: explicit-pull, reusing the recall idiom)

Expose the current user model through the recall surface as a dedicated scope (or a
thin sibling tool), so the model pulls it the same way it pulls recall — and so it
inherits the next-turn cache-warming RFC's latency win for free, without inheriting
any injection. Opening the surface triggers nothing model-visible on its own.

### D. Grade (chosen: the candidate axiom's method, second-ring instance)

Each fact carries `measured` / `estimated` / `inconclusive`:

```text
measured       corroborated by independent later-session evidence (the user acted
               consistently with the fact, or restated it)
estimated      authored once from a single session, not yet corroborated
inconclusive   conflicting evidence, or below an evidence floor
```

This is the candidate axiom (`Account the unmeasurable; grade the claim;
calibrate, don't assert`) exercised on a _second distinct ring_ beyond compaction
economics — the explicit cross-ring proof the candidate note requires before
promotion. A fact's grade is evidence; it never gates anything.

## Landing Plan

Three phases:

1. **Vocabulary + projection, author-only.** Add the `user_fact` advisory event and
   the rebuildable user-model projection; the model can author facts and the
   projection folds them. No retrieval surface yet — pure storage + read model,
   reversible.
2. **Explicit-pull retrieval.** Expose the projection through a recall scope / sibling
   tool; confirm opening it injects nothing and that retrieval is the only reveal.
3. **Grade + calibration.** Add the per-fact honesty grade and the corroboration
   rule that promotes `estimated → measured`; record this as the candidate axiom's
   second proving instance, feeding its promotion gate (not this RFC's).

## Source Anchors

- Model-authored advisory lane (where a `user_fact` is recorded): the workbench
  advisory model named in `docs/architecture/design-axioms.md` and
  `@brewva/brewva-vocabulary` (custom/advisory events with `authority: "advisory"`)
- Fact-ownership precedent this RFC reuses (recall-versus-summary):
  `docs/research/active/rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md`
- Projection + rebuildable-read-model discipline:
  `docs/reference/working-projection.md`, `@brewva/brewva-session-index`
- Explicit-pull retrieval idiom to reuse: `RecallBroker` in
  `packages/brewva-recall/src/broker/broker.ts` and the `recall_search` tool
- Latency inheritance: the recall next-turn cache-warming RFC
- The discipline this RFC instances: `candidate-axiom-accounting-for-unmeasurable-benefit.md`
- Peer precedent (read-only, external repo): `hermes`'s `agent/memory_provider.py`
  (`MemoryProvider` ABC) and `plugins/memory/honcho/` (dialectic user modeling)

## Validation Signals

- A model-authored `user_fact` is durable across a restart (replayed from tape) and
  the projection rebuilds deterministically from the events alone.
- Opening the user-model retrieval surface triggers no recall, no materialization,
  no provider call, and adds zero prompt bytes — retrieval via the tool is the only
  reveal (the projection discipline, asserted).
- A revised preference supersedes its prior without erasing it; the projection
  returns the latest and the audit chain preserves the history.
- A fact corroborated by independent later evidence grades `measured`; a once-asserted
  fact stays `estimated`; conflicting evidence grades `inconclusive`.
- The grade gates nothing: a `measured` user fact grants no capability, routes no
  model, and bypasses no approval (asserted).

## Surface Budget

Counts are for the recall/user-model surface only; before → after.

- Required authored (model-facing) fields: 0 → 0. A user fact is _optionally_
  authored by the model when it concludes one, never a required field.
- Optional authored fields: +1 model-authored advisory `user_fact` (fact, scope,
  grade, supersedes).
- Author-facing concepts: +1 model-facing concept ("user fact / user model"). +0
  operator concepts beyond an inspect view.
- Inspect surfaces: +1 user-model view over the projection (explicit-pull).
- Routing / control-plane decision points: +0. The user model is advisory evidence;
  nothing reads it to gate a turn, route a model, or grant a capability.
- Config keys: +0 in v1.
- Public CLI surfaces: +0 new commands (the model is pulled via the recall surface;
  inspect renders it read-only).
- Persisted formats: +1 advisory event schema (`user_fact`); the projection is
  rebuildable, not persisted as truth.
- net required authored fields: 0. debt owner: recall + vocabulary maintainers.
  re-evaluation trigger: any proposal to auto-inject the user model, to run runtime
  dialectic inference, or to let a user fact derive an authority — each re-opens the
  axiom-1/2/18 boundary and needs a fresh review.

The user model lands entirely as model-authored advisory evidence over the tape,
surfaced explicit-pull. It seizes no attention, stores no second brain, and grants
no authority — which is exactly what makes it a clean second proving ring for the
unmeasurable-benefit axiom.

## Promotion Criteria And Destination Docs

Promote a phase only when its validation signals pass against a green
`bun run check` and the full suite, including the no-injection and grade-gates-nothing
assertions.

- The `user_fact` vocabulary and the user-model projection contract →
  `docs/reference/runtime.md`.
- The explicit-pull retrieval and grade/calibration loop →
  `docs/journeys/operator/recall-and-knowledge-compounding.md`.

On acceptance, convert this note to a single-decision record under
`docs/research/decisions/` citing axioms 1, 6, 11, and 18, and record it as the
candidate axiom's second proving instance.

## Open Questions

- Fact scoping: per-user only, or also per-workspace / per-project? A standing
  constraint may be project-local, not a global trait.
- Conflict resolution: when two sessions author contradictory facts, is latest-wins
  enough, or does the grade need to drop to `inconclusive` until corroborated?
- Optional external dialectic enrichment: is there an axiom-clean way to let an
  external service (Honcho-style) _propose_ candidate facts the model then chooses
  to author — advisory in, model authors out — without it becoming a runtime
  inference engine? Deferred until the native projection proves itself.
- Eviction/decay: does a stale `estimated` fact expire, and does that interact with
  the corroboration rule?

## Related Work

- The discipline this RFC instances and helps promote: the unmeasurable-benefit
  candidate axiom (this is its required second ring).
- Fact-ownership precedent reused: the reversible-references RFC (recall-versus-summary).
- Latency the retrieval surface inherits: the recall next-turn cache-warming RFC.
- Attention sovereignty and no-second-store: axiom 1, axiom 6, and the
  "second memory store for attention options" anti-pattern.
