# RFC: Attention As An Accountable Effect

## Metadata

- Status: active
- Implementation state: Phase 1 (attention-selection receipts) implemented end to
  end against a green pipeline. Phase 2 (retention dashboard) and Phase 4
  (promotion signal) have their aggregation/selection ALGORITHMS implemented as
  pure, tested vocabulary functions (`projectRetentionDashboard`,
  `collectRetentionPromotionSignals`); the session-level assembly readers and the
  inspect surface that renders them fold into the Phase 5 follow-up, so no
  orphaned glue ships. Phase 3 (attention budget) deferred after a feasibility
  pass — the objective taxonomy exists but per-tool-call token attribution does
  not. Phase 5 (surface amplification) spun off as a follow-up.
- Owner: Runtime, gateway, tools, and operator-experience maintainers
- Last reviewed: `2026-06-16`
- Depends on:
  - [RFC: Reversible References, Advisory Compression Routing, And Replay-Distilled Precedent](./rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md)
  - [RFC: Effect Approval And Rollback Closure](../archive/rfc-effect-approval-and-rollback-closure.md)
  - [RFC: Context Operating System And Compaction Physics](./rfc-context-operating-system-and-compaction-physics.md)
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/journeys/operator/interactive-session.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `docs/reference/events/README.md`
  - `docs/reference/runtime.md`

## Problem Statement

Brewva already makes two classes of consequence receipt-bearing and
replay-derived. Effect commitment, approval, and patch rollback close over
tracked mutations (the effect-approval RFC). Reversible context references and
replay-distilled precedent close over evicted spans and learned failure patterns
(the reversible-references RFC). In both, a model action that matters leaves a
durable receipt, and operator surfaces project that receipt without becoming
authority.

One first-class action is only generically instrumented, not accountably so:
**attention selection itself**. When the model consumes an attention option,
marks a note for retention, signals that a note deserves cross-session
promotion, or bets part of a turn's budget on exploration versus implementation,
the system keeps at most a generic metric, not typed, per-entry, replay-derived
evidence tied to the note the choice concerns. The aesthetic claim `Model owns
attention` is therefore measurable in aggregate but not accountable per choice:
it cannot feed cross-session promotion, and it cannot become strategy.

Verified current-state gaps (see Source Anchors for file lines):

- `workbench_note` accepts a `retention_hint` argument, but the hosted note
  builder drops it; it is never stored on the `WorkbenchEntry`.
- `WorkbenchEntry` has no consume-count or last-consumed field, so "this note
  earned its keep" is unrepresentable.
- `attention_consume` already records a generic `attention.consume` metric
  (persisted as `iteration.metric.observed`) plus an
  `attention.option_consume_ratio`, returning an `eventId`. What is missing is a
  _typed_ semantic vocabulary event, a _per-entry_ consume projection tying
  consumption back to a specific `WorkbenchEntry`, and a _promotion-grade_
  signal: a generic rate measures how often, not which note earned its keep.
- `workbench.eviction.recorded` / `workbench.eviction.undone` are hardcoded
  event strings rather than vocabulary constants, so evict-then-undo rate is not
  cleanly queryable.
- `resource_lease` leases `maxToolCalls` / `maxTokens` / `maxParallel` only, and
  is reactive (ask for more when blocked). There is no declared attention budget
  and no declared-versus-actual evidence.

This RFC closes that gap. It upgrades attention selection from generic-metric
evidence to a typed, per-entry, replay-derived effect, completing the grammar the
other two RFCs already follow, and it names the aesthetic that grammar produces
so future features can converge on it.

## The Governing Grammar

The three RFCs share one invariant, stated here for the first time as a single
line:

`Selection is an effect; reversal is an effect; both leave receipts.`

- **Reversal as a receipt-bearing effect** is realized: patch rollback over
  tracked `PatchSet` material (effect-approval RFC) and `RcrReference` reversal
  of evicted/compacted spans (reversible-references RFC).
- **Selection as a receipt-bearing effect** is the under-instrumented half:
  consume, retain, promote-signal, and budget commitment exist at most as generic
  metrics today, not as typed, per-entry, promotion-grade receipts. This RFC.

The aesthetic these produce should get a propagable name so team prose, prompts,
and review converge on it:

`Model-sovereign, tape-accountable context.`

This is deliberately not "glass-box." A glass box promises visibility only.
Brewva promises more than visibility: every model-sovereign choice is auditable,
replay-derivable, reversible where tracked, and measurable. `tape-accountable`
carries that full set because all of it is anchored on tape; `model-sovereign`
preserves the first axiom. The name holds the tension that actually distinguishes
Brewva — autonomy paid for with accountability — rather than naming only the
autonomy or only the transparency.

## Scope Boundaries

In scope:

- attention-selection receipts: `consume`, retention signal, promotion signal,
  and budget commitment as durable, replay-derived evidence
- `WorkbenchEntry` field closure: persist the already-accepted `retention_hint`
  and add a consume-count signal (vocabulary-owned), coordinated with the
  reversible-references RFC's `RcrReference` extension of the same type
- attention event vocabulary: a typed `attention.option.consumed` semantic event
  (beyond today's generic `attention.consume` metric), a per-entry consume
  projection, and promotion of the hardcoded eviction strings to vocabulary
  constants
- an attention-budget commitment that is **verify-only**: declared split,
  recorded actual, projected variance, never an admission gate
- aesthetic instrumentation: a retention dashboard over consume rate,
  evict-then-undo rate, and forced-compaction rate, with an attribution
  dimension
- surface amplification: distribute the constitution onto the surfaces it
  describes; make the Work Card the default orient projection by first unifying
  its payload; promote `Context Runway` to product lexicon; split product versus
  implementation lexicon and lint it
- naming the grammar and the aesthetic for `design-axioms.md`

Out of scope (owned elsewhere; reused, not rebuilt):

- promotion-to-persistent-precedent mechanics — owned by the reversible-references
  RFC (RDP, `knowledge_capture`, `docs/solutions/**`). This RFC only feeds it a
  signal.
- filesystem/patch reversal mechanics — owned by the effect-approval RFC. This
  RFC adds no rollback engine.
- runtime-automatic salience selection or background promotion. Forbidden by the
  first axiom and the cognitive-product non-goals; explicitly rejected below.
- gating model cognition by a budget commitment. Would violate
  `Govern effects, not thought paths`.
- generic filesystem undo / universal workspace snapshot. Rejected by the
  effect-approval rollback aesthetic (`rollback is not a moral promise`).
- new providers, implicit physics modes, private runtime seams, or ACP/MCP wire
  changes.
- multi-agent attention governance. The stable transaction boundary stays
  `single tool call` (axiom 17).

Out of scope but tracked for future work:

- whether an `opencode`-style whole-workspace snapshot could augment tracked
  patch rollback for _untracked_ mutations, and how to keep its honesty boundary
  distinct from tracked rollback so it never reads as universal undo. This must
  be reconciled with the effect-approval RFC before it is anything but a note.
- streaming-time attention commitments (the model committing or revising a
  budget mid-turn rather than at tool boundaries), tracked jointly with the
  context-OS RFC's streaming-time self-management item.
- folding budget commitment into `resource_lease` versus a separate receipt,
  decided at surface-budget review.

## Why

Future models will have larger windows and stronger self-management. Larger
windows do not remove attention pressure; they raise the cost of bad attention
economics and make the _quality of the model's own attention decisions_ the
dominant variable. A future-facing runtime should therefore let the model own
attention strategy and have the runtime verify it, not orchestrate it.

This is also where Brewva's moat is widest, and the comparison is instructive
precisely because peers solve adjacent problems the opposite way:

- `claude-code` consolidates memory with a background `autoDream` pass: a forked
  subagent, gated on elapsed time and session count, that silently distills
  session content into durable memory. It is effective, and it is exactly the
  runtime-owned salience Brewva forbids — promotion with no model-sovereign
  choice and no per-decision receipt.
- `opencode` reverts via a whole-workspace git snapshot restore. It is powerful,
  and it is the universal-undo promise the effect-approval RFC rejects: it
  recovers state without a tracked-mutation receipt that says exactly what was
  reversible and why.

Brewva's distinctive promise is the inverse of both: **autonomy with receipts.**
The model selects; the kernel and tape account. That promise is currently
unprovable for attention because the receipts do not exist. Closing this gap is
what lets Brewva say, after the fact, _which option the model chose to read, why
a note survived to the next session, and whether the model spent its attention
the way it said it would_ — questions neither a background dreamer nor a
whole-disk snapshot can answer.

## Direction

Present attention selection exactly as the other two RFCs present their domains:
model-operated, runtime-governed, receipt-anchored.

1. **Selection is an effect.** Consuming an attention option, retaining a note,
   and signaling promotion each produce a durable, replay-derived receipt. None
   of them is an in-memory mutable flag.
2. **Runtime nominates, model selects, tape accounts.** The runtime may surface
   retention or consume signals as candidate cards; it never auto-promotes,
   auto-consumes, or auto-evicts. This preserves the first axiom and the
   `no runtime-owned attention selector` non-goal.
3. **Budget commitment is verify-only.** A declared attention budget is recorded
   and reconciled against actuals as honest evidence (`inconclusive`-friendly,
   per axiom 7). It never blocks a tool call or steers cognition; the runtime
   reports variance, it does not enforce a plan. This keeps
   `Govern effects, not thought paths` intact.
4. **Measurement must attribute.** A retention dashboard distinguishes
   aesthetic-failure (the option model is wrong) from implementation-bug (the
   surface is broken) from model-capability (the model used it poorly). A bare
   rate without attribution would let the aesthetic flatter or condemn itself
   dishonestly.
5. **Surfaces self-describe.** The constitution belongs on the surface it
   governs, not as a global banner: `Model sees workbench and options` on the
   workbench drawer, `Operator sees work cards` on the Work Card, `Kernel sees
receipts` on the tape view. Each surface proves its own line.

## Architectural Positions

- **No second authority for attention state.** Consume count, last-consumed
  time, and budget actuals are derived from tape events, never from a mutable
  field a UI or the model writes directly. `retentionHint` is the one durable
  attention field on `WorkbenchEntry`; the consume-derived figures are
  projection/read-model fields, never stored or mutated on the entry. This
  mirrors the effect-approval rule that consumed posture is replay-derived.
- **Behavior-changing attention state is replay-derived; visibility-only state is
  projection-visible.** Promotion eligibility and budget variance change behavior
  downstream and must be replay-derived. A dashboard count is visibility-only and
  may live in a projection. This is the existing state-visibility rule from
  `design-axioms.md`, applied here.
- **`WorkbenchEntry` is shared vocabulary; coordinate the extension.** The
  reversible-references RFC already extends `WorkbenchEntry` with an optional
  `RcrReference`. This RFC adds exactly one durable field to the same record —
  `retentionHint` — and nothing else; consume count and last-consumed time are
  projection fields, not entry fields. Both extensions are vocabulary-owned and
  additive; Phase 0 confirms one combined shape so the two RFCs do not collide on
  the type.
- **Budget commitment needs an objective actual, or it is a hidden classifier.**
  A declared split is evidence, not a schedule the runtime executes. But the
  _actual_ side is the hard part: exploration-versus-implementation is not a
  dimension existing cost or `ContextStatus` physics can derive, so reconciling
  against it would require classifying each effect — itself a hidden classifier
  that violates `Govern effects, not thought paths`. Budget commitment is
  therefore gated on first defining a taxonomy whose buckets are objectively
  derivable from existing receipts; absent that, it stays an open design, not a
  built feature (`cognitive-product` no-hidden-planner non-goal).
- **The Work Card unifies before it defaults.** The doc already claims the Work
  Card is the first operator surface; the code is transcript-first and each
  surface builds its own projection. The honest order is: unify the
  schema-tagged payload across shell/channel/headless first (low risk), then
  switch the default orient surface (reversible).

## Source Anchors

Stable docs and project rules:
`docs/architecture/design-axioms.md`,
`docs/architecture/cognitive-product-architecture.md`,
`docs/journeys/operator/interactive-session.md`,
`docs/reference/tools/memory-and-recall.md`,
`docs/reference/events/README.md`.

Internal implementation anchors:

- `packages/brewva-vocabulary/src/internal/workbench.ts` (`WorkbenchEntry`, no
  `retentionHint`/consume field)
- `packages/brewva-tools/src/families/memory/workbench.ts` (`retention_hint`
  argument accepted)
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/workbench.ts`
  (`note()` drops `retention_hint`; eviction events are hardcoded strings)
- `packages/brewva-vocabulary/src/internal/iteration.ts` (`ResourceLeaseBudget`,
  `ResourceLeaseRecord`)
- `packages/brewva-vocabulary/src/internal/context.ts` (compaction event family,
  `ContextStatus.forcedCompaction`)
- `packages/brewva-cli/src/shell/domain/cockpit/types.ts` (`runway` already
  present)
- `packages/brewva-cli/src/shell/domain/overlays/projectors/inspect.ts` (Work
  Card is inspect section `0`, behind a drill-down)
- `packages/brewva-tools/src/families/memory/recall.ts`,
  `packages/brewva-tools/src/families/memory/solution-record.ts`
  (`promotion_candidate` / `promoted_to` vocabulary already exists)

External comparison anchors (contrasts, not ports):

- `/Users/bytedance/new_py/claude-code/src/services/autoDream/autoDream.ts`,
  `/Users/bytedance/new_py/claude-code/src/services/extractMemories/extractMemories.ts`
  (background, runtime-owned promotion — the salience Brewva forbids)
- `/Users/bytedance/new_py/opencode/packages/opencode/src/session/revert.ts`,
  `/Users/bytedance/new_py/opencode/packages/opencode/src/snapshot/index.ts`
  (whole-workspace snapshot undo — the universal-undo promise Brewva rejects)

## Architecture Proposal

### 1. Attention-Selection Receipts

Make each attention selection durable and replay-derived.

- **Persist retention.** Store the already-accepted `retention_hint` on the
  `WorkbenchEntry` (vocabulary-owned). This fixes a silent drop today, not a new
  field on the wire.
- **Type the consume receipt.** `attention_consume` already emits a generic
  `attention.consume` metric and an `attention.option_consume_ratio`; add a
  _typed_ `attention.option.consumed` vocabulary event alongside it, carrying the
  consumed option and ref identity rather than only a rate. Derive a per-entry
  consume count and last-consumed time as projection/read-model fields from these
  events (last-consumed time derives from the receipt's event timestamp, since
  ops-advisory events carry no turn id); do not store a counter on the
  `WorkbenchEntry`.
- **Promote the eviction events.** Replace the hardcoded
  `workbench.eviction.recorded` / `workbench.eviction.undone` strings with
  vocabulary constants so evict-then-undo is a first-class query.

Authority placement: the field and event shapes live in
`@brewva/brewva-vocabulary`; emission lives in the hosted runtime ops builders;
derivation lives in the session-index / projection layer. No new store, no new
package.

### 2. Attention Budget Commitment (Verify-Only, Taxonomy-Gated)

The intent is the strategic half of `Model owns attention`: today the model
reads the runway gauge reactively; here it could commit to a strategy and have
the runtime verify, not orchestrate. But neither side is implementable yet, and
this RFC says so rather than papering over it.

- **The declared side has no taxonomy.** "Exploration versus implementation" is
  not a category the runtime owns. A declaration entry must first define an
  attention-budget taxonomy whose buckets are well-defined enough to declare
  against.
- **The actual side has a partial objective mapping — counts, not tokens.** A
  feasibility pass confirmed an objective taxonomy DOES exist: every tool's
  `actionClass` (and its derived `safe`/`effectful` boundary) is policy-assigned
  per tool and recorded on the `tool.proposed` / `tool.committed` tape events, so
  tool-call counts per class are objectively replay-derivable. But attention
  budget is about token/context spend, and `cost.observed` is a per-turn aggregate
  with no per-tool-call attribution — so token-per-class actual is NOT
  tape-derivable. Computing it would require splitting a turn's cost across its
  tool calls: a hidden classifier that violates `Govern effects, not thought
paths`, the exact trap this RFC guards against.
- **The prerequisite is the work.** Before any variance projection, define: (a)
  the budget taxonomy, (b) the declaration entry, and (c) the objective mapping
  from existing receipts to per-bucket actual spend. The mapping must derive from
  facts already on tape, never from a fresh judgment about what the model was
  "doing."
- **Only then, verify-only.** Once (a)–(c) exist, the declaration is a receipt
  and variance is a projection that is **never** an admission gate; thin evidence
  projects `inconclusive` (axiom 7), it never steers or stops cognition. Shape
  (`ResourceLeaseBudget` dimension versus a separate `attention_commitment`
  receipt) is a surface-budget decision; `resource_lease` stays the reactive
  negotiation primitive (axiom 9).

**Phase 3 verdict: deferred.** A token-denominated attention-budget variance is
not buildable today and is intentionally not shipped. The unlock condition is
concrete: add per-tool-call cost attribution on tape (a `toolCallId` on
`cost.observed`, or per-call token accounting), after which token-per-`actionClass`
actual becomes objectively derivable and the verify-only projection can be built. A
tool-call-count budget per `actionClass` IS buildable now, but that is an action
budget, not an attention budget; conflating the two would mislead, so it is left as
a separate future option rather than a stand-in. A variance projection shipped
without an objective token actual would be a hidden classifier wearing a receipt's
clothes.

### 3. Promotion Signal Bridge (Reuse RDP)

Do not build a second promotion path. Feed the reversible-references RFC's RDP
candidate pipeline an additional, model-sovereign signal: notes with
promotion-eligible stored `retentionHint` values or repeated consumption become
**promotion candidates** at
handoff or session end. Promotion to an active `docs/solutions/**` record stays
gated through `knowledge_capture` with human review, exactly as RDP already
specifies.

This is the brewva-native answer to `claude-code`'s `autoDream`: the runtime
nominates from real attention receipts; the model or operator promotes; tape
accounts. No background pass, no silent salience.

### 4. Aesthetic Instrumentation

A retention dashboard over the now-available receipts. The rates mostly already
have sources:

- **Consume rate** already exists as the `attention.option_consume_ratio`
  metric; the dashboard surfaces it, it does not invent it. Tests whether
  "attention options beat prompt stuffing" actually holds.
- **Evict-then-undo rate** = the (newly typed) eviction-undone over
  eviction-recorded events. Tests whether model-curated eviction is trustworthy
  (high undo = too aggressive).
- **Forced-compaction rate** = `context.critical_without_compact` over sessions.
  Already fully instrumented; tests whether model-managed runway works.

The rates reuse Phase 1 receipts and existing metrics. The **attribution
dimension** (aesthetic / implementation / capability) is the one piece that needs
a new input, and its source must be explicit: attribution is a human annotation
or a recorded guard result, **never a projection heuristic** — a heuristic that
guesses "this low rate is a model-capability problem" would be the same hidden
classifier rejected for budget actuals. Unattributed metrics default to `unknown`
/ `inconclusive` (axiom 7), never to a flattering or damning guess. This is the
honest-adjudication discipline from axiom 7 applied to the aesthetic itself.

### 5. Surface Amplification

- **Distribute the constitution.** Print each clause on the surface it governs
  (workbench drawer, Work Card, tape view) as descriptive taste, not as new
  authority (axiom 14). The first line and the SDK/README header carry the full
  `Model-sovereign, tape-accountable context` name.
- **Work Card default orient, in two steps.** Step 1: unify the schema-tagged
  Work Card payload so shell, channel, and headless consume one projection. Step
  2 (reversible): make it the default orient surface, with transcript, raw tape,
  and ledger as drill-downs — realizing the cognitive-product claim the code does
  not yet meet.
- **Promote `Context Runway` to product lexicon.** The `runway`
  (turns-until-high-pressure, burn-rate) concept already exists in the cockpit;
  name it `Context Runway` in the product lexicon instead of leaking
  `numeric context status`.
- **Two-tier lexicon + doc lint.** Product lexicon (`Work Card`,
  `Workbench Entry`, `Attention Option`, `Effect Receipt`, `Continuation
Anchor`, `Context Runway`) is stable and may appear in user-facing docs.
  Implementation lexicon (`ContextBundle`, `materialization`, `dynamic tail`)
  stays in research and implementation docs. A docs lint fails a user-facing doc
  that leaks implementation lexicon — making axiom 14 machine-enforced and
  catching exactly the drift this surface work fixes.

### 6. Name The Grammar In `design-axioms.md`

Add `Selection is an effect; reversal is an effect; both leave receipts` as the
implementation-grade reading that unifies the attention, effect, and reversal
RFCs, and record `Model-sovereign, tape-accountable context` as the propagable
name for the aesthetic the axioms already encode. This is an authority-narrow
addition: it names existing invariants, it does not widen kernel authority.

## How To Implement

### Phase 0: Boundary Confirmation

- Confirm one combined vocabulary shape for the `WorkbenchEntry` extension that
  carries both this RFC's `retentionHint`/consume signal and the
  reversible-references RFC's optional `RcrReference`, so the two RFCs share one
  additive change to the type.
- Confirm the `attention_consume` path has a clean emission seam for
  `attention.option.consumed` and that consume count can be derived without a
  mutable counter.
- Confirm whether budget commitment extends `ResourceLeaseBudget` or stands as a
  separate receipt (surface-budget review).

### Phase 1: Attention-Selection Receipts (P0 — unlocks the rest)

- Persist `retention_hint`; add the consume event and eviction-event constants;
  derive consume count and last-consumed time in projection.
- Fitness: every `attention_consume` emits a receipt; retention survives replay;
  no mutable attention counter is load-bearing.

### Phase 2: Retention Dashboard (cheap after Phase 1)

- Aggregation ALGORITHM (implemented): `projectRetentionDashboard` computes
  consume rate (from the existing `attention.option_consume_ratio`),
  evict-then-undo rate, and forced-compaction rate from supplied counts. Rates are
  inconclusive (`null`) without a denominator; attribution is an explicit input
  defaulting to `unknown`, never inferred. No new emission beyond Phase 1.
- Deferred to Phase 5: the session-level reader that counts those events from
  `runtime.ops` and the inspect surface that renders the dashboard. Building the
  reader now would be orphaned glue, so the algorithm ships pure and the
  ops-facing assembly lands with its consumer.

### Phase 3: Attention Budget Commitment (taxonomy-gated)

- **Deferred (feasibility pass complete).** The objective taxonomy exists
  (`actionClass` on `tool.committed`), but the token-per-class actual does not:
  `cost.observed` is per-turn, with no per-tool-call attribution. Phase 3 is
  therefore NOT built; it is gated on adding per-call cost attribution to tape.
- When that unlock lands: add the declaration receipt and the
  declared-versus-actual projection; a budget commitment must never change a
  kernel admission decision, and actual spend must derive only from existing
  receipts, never from a fresh per-effect classification.

### Phase 4: Promotion Signal Bridge

- Selection ALGORITHM (implemented): `collectRetentionPromotionSignals` nominates
  notes the model marked with a promotion-eligible `retentionHint` or consumed
  repeatedly; it only nominates. No runtime path writes a `status: active` record
  from attention signals; promotion stays `knowledge_capture`-gated and
  model/operator-initiated.
- Deferred to Phase 5: the session-level reader that assembles candidates from
  `runtime.ops` and feeds them to the `knowledge_capture` flow, landed with its
  consumer rather than as orphaned glue.

### Phase 5: Surface Amplification (non-blocking follow-up)

- Not a promotion gate for this RFC. Includes the session-level readers that
  assemble the retention dashboard and promotion candidates from `runtime.ops`
  plus the Phase 2/4 pure projections, and the inspect surface that renders them
  (the RFC-counted inspect surface). Also: unify the Work Card payload, then
  switch the default orient surface; distribute the constitution; promote
  `Context Runway`; land the two-tier lexicon doc lint. Tracked for coherence, but
  may move to a separate surface RFC; must not block the receipt and retention
  closure that is this RFC's core.

## Validation Signals

Required tests and checks:

- selection-receipt fitness: `attention_consume` emits the typed
  `attention.option.consumed` event in addition to the existing
  `attention.consume` metric; consume count and last-consumed time are
  replay-derived projection fields stable across index rebuild, with no counter
  stored on the entry
- retention-persistence fitness: a stored `retention_hint` survives note
  read-back and replay; the prior silent-drop behavior is regression-guarded
- eviction-constant fitness: evict-then-undo is queryable through vocabulary
  constants, not string matching
- budget-commitment fitness (only if built): the taxonomy and an objective
  tape-derived actual mapping exist first; a declared budget never alters kernel
  admission or commit; actual spend is never a fresh per-effect classification;
  thin evidence projects `inconclusive`, never a fake pass/fail
- no-auto-promotion fitness: no runtime path promotes a note to persistent
  precedent without a model or operator action; RDP gating is unchanged
- dashboard-attribution fitness: each metric exposes its attribution dimension
- Work Card single-source fitness (non-blocking follow-up): shell, channel, and
  headless consume one schema-tagged Work Card payload before the default surface
  switches
- lexicon-lint fitness (non-blocking follow-up): a user-facing doc that leaks
  implementation lexicon fails the docs lint
- docs verification with `bun run test:docs`
- Markdown formatting check with `bun run format:docs:check`

Promotion should also require at least one inspect artifact showing an attention
consume receipt and its derived per-entry consume count. A budget-commitment
variance projection is required only if budget commitment is built; if it stays
taxonomy-gated, promotion records that deferral instead.

## Surface Budget

_Counts are net additions introduced by this RFC (`before = 0`), except
author-facing concepts, which counts against the established public set._

| Surface                               | Before | After | Notes                                                                                                                                                                                                                                                |
| ------------------------------------- | -----: | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | No new required user configuration.                                                                                                                                                                                                                  |
| Optional authored fields              |      0 |     0 | Budget commitment is a model action, not authored config; the doc lint is a check, not a field.                                                                                                                                                      |
| Author-facing concepts                |      6 |     8 | Adds `attention budget commitment` and `Context Runway` (promoting an existing internal concept) to product lexicon.                                                                                                                                 |
| Persisted formats                     |      0 |     3 | `WorkbenchEntry.retentionHint` (storing an already-accepted arg); a typed `attention.option.consumed` event (the generic `attention.consume` metric already exists); eviction event constants. Consume count is a projection, not a persisted field. |
| Inspect surfaces                      |      0 |     1 | The retention dashboard. Work Card unification reshapes an existing surface rather than adding one.                                                                                                                                                  |
| Public tools                          |      0 |     0 | Reuses `attention_consume`, `workbench_note`, `resource_lease`; no new tool.                                                                                                                                                                         |
| Routing/control-plane decision points |      0 |     0 | Budget commitment is verify-only and adds no admission branch.                                                                                                                                                                                       |

Positive surface delta:

- Debt owner: runtime, gateway, tools, and operator-experience maintainers.
- Why unavoidable: attention selection has only generic-metric evidence today,
  so it cannot be promoted per note or made strategic without typed, per-entry
  receipts; the budget is kept minimal by reusing the RDP promotion path, the
  existing consume/compaction metrics, and existing tools instead of adding a
  store, a promoter, or a planner.
- Dated re-evaluation trigger: by `2026-09-30`, before any promotion to
  `docs/research/decisions/`, re-evaluate whether budget commitment should fold
  into `resource_lease`, and whether the consume signal should collapse into the
  reversible-references `WorkbenchEntry` extension as one field set.

## Promotion Criteria

Move this note to `docs/research/decisions/` only after the core receipt closure
holds:

- attention consume, retention, and eviction are receipt-bearing and
  replay-derived under fitness tests, with no mutable attention state
  load-bearing for behavior
- the `retention_hint` silent drop is fixed and regression-guarded, with a typed
  `attention.option.consumed` event and a per-entry consume projection
- the promotion signal bridge feeds RDP candidates without any runtime
  auto-promotion, and RDP `knowledge_capture` gating is unchanged
- budget commitment is either proven verify-only over an objective tape-derived
  actual, or explicitly recorded as taxonomy-gated and deferred — not shipped as
  a guess-based variance projection
- `design-axioms.md` carries the named grammar and aesthetic as authority-narrow
  additions
- source anchors in this note either move into stable docs or decision records

Surface amplification (Work Card default, `Context Runway`, the two-tier lexicon
doc lint) is a non-blocking follow-up and is **not** a promotion gate for this
note; it may ship separately.

## Open Questions

- The Phase 3 taxonomy question is answered (`actionClass` on `tool.committed` is
  objectively replay-derivable), but the unlock is per-tool-call cost attribution:
  should `cost.observed` carry a `toolCallId`, or should token accounting move
  per-call, so token-per-`actionClass` actual becomes tape-derivable without a
  hidden classifier?
- Should attention budget commitment extend `ResourceLeaseBudget` or stand as a
  separate `attention_commitment` receipt? (Surface-budget preference: reuse.)
- Should the consume signal be a derived count only, or also a small durable
  digest of _what_ was consumed, for promotion quality?
- At what retention/consume threshold does a note become an RDP promotion
  candidate, kept small and high-signal?
- Should the constitution clauses render in model-visible context as well as
  operator surfaces, or operator-only to avoid prompt-shaping?
- When an attention consume receipt and an `RcrReference` reversal refer to the
  same span, how should inspect cross-link them without implying shared
  authority? (Shared with the reversible-references RFC's last open question.)

## Related Docs

- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/journeys/operator/interactive-session.md`
- `docs/research/active/rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md`
- `docs/research/archive/rfc-effect-approval-and-rollback-closure.md`
- `docs/research/active/rfc-context-operating-system-and-compaction-physics.md`
