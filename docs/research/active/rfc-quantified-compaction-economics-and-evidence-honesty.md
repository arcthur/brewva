# RFC: Quantified Compaction Economics And Graded Evidence Honesty

## Metadata

- Status: active
- Owner: Runtime, gateway, and CLI-inspect maintainers
- Last reviewed: `2026-06-26`
- Depends on:
  - [Decision: Context Operating System And Compaction Physics](../decisions/context-operating-system-and-compaction-physics.md)
  - [RFC: Reversible References, Advisory Compression Routing, And Replay-Distilled Precedent](./rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md)
  - [RFC: Peer-Distilled Context Loops — Compaction Effectiveness, Reference Staleness, And The Context Ledger](./rfc-peer-distilled-context-loops.md)
  - [RFC: Attention As An Accountable Effect](./rfc-attention-as-an-accountable-effect.md)
- Promotion target:
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`

## Problem Statement

Brewva already treats compaction economics as evidence, not authority: the
context-OS decision fixed that `cache_regression`, `unaccounted_break`, and
`wasteful` are inspectable verdicts the model and operator read, while replay
authority stays on tape and stored baselines. The reversible-references RFC
already re-homed `headroom`'s compression _capability_ (RCR/ACR/RDP), and the
peer-distilled RFC already closed the evidence-fit feedback loop as an
operator-reviewed `report:context-evidence --recommend` posture.

This RFC takes a third pass at `headroom`, but at its current surface — the
`#856` net-cost arc and the counterfactual-savings work shipped across the most
recent development wave, none of which existed when the earlier two RFCs were
written. A disciplined read shows the same pattern the peer-distilled RFC found:
**most of the new surface is COVERED by Brewva or REJECTED by its axioms.** The
genuine residue is two things Brewva has the _category_ for but not the _rigor_:

1. The economic verdict carries a free-form `metrics: Record<string, number | null>`
   bag and a `reason` string, but no quantified net-value and no break-even — so
   `wasteful` is asserted qualitatively from a cache-creation-ratio heuristic
   (`buildCompactionEconomicVerdicts`). `headroom`'s `#856` formula is the
   missing math.
2. No verdict grades its own certainty. Brewva already records the control arm
   (`provider_cache_observation` correlated post-compaction) but only as
   aggregate counts, and it never labels a verdict as _measured_ versus
   _estimated_. `headroom`'s three-tier honesty model (measured A/B holdout,
   estimated synthetic control, direct property) is the missing discipline, and
   it is exactly axiom 7 (`Inconclusive is honest governance`) made literal on
   the verdict.

The critical filter, in the grammar the attention RFC established
(`Model-sovereign, tape-accountable context`):

> Compaction economics inform attention; they never seize it — and a verdict that
> cannot prove itself must grade itself.

`headroom` owns attention: its proxy mutates cached messages on the model's
behalf and hides it. Brewva must refuse that control shape (axiom 1) and keep
only the physics: the economic _model_ becomes graded evidence on the verdict,
consumed by the model's attention tools and by the operator recommendation, never
a runtime-owned mutation trigger. The compaction gate already exists; this RFC
adds zero runtime decision points.

This RFC is a direction, not a drop-in: the formula, its input availability, the
per-verdict provenance needed for a credible grade, and the schema version
semantics all need closing before any verdict changes. The phased landing plan
below keeps the operator-visible verdict distribution stable during calibration.

## Scope Boundaries

In scope:

- a typed, quantified `netReuseValue` plus an auditable `netReuseInputs` bag on
  `ContextEvidenceEconomicVerdict`, computed by a pure helper from a Brewva-native
  adaptation of `headroom`'s net-cost model
- per-verdict provenance (`source`) and a `grade`
  (`measured` / `estimated` / `inconclusive`) on every economic verdict, derived
  by joining a specific verdict to a specific `provider_cache_observation`
- a break-even and idle-decay sharpening of the existing
  `report:context-evidence --recommend` posture (peer-distilled Loop 4), still
  config-time and operator-reviewed

Out of scope (owned elsewhere; this RFC must not re-open):

- reversible reference design, `recall_expand`, advisory content-shape routing,
  precedent distillation → reversible-references RFC
- the `compaction_ineffective` skip posture, workbench staleness, the context
  ledger → peer-distilled RFC (this RFC adds evidence rigor, not a new skip)
- per-entry attention receipts, `retention_hint`, consume events → attention RFC
- any runtime-owned mutation of cached messages, output-verbosity prompt
  injection, or model-effort steering → forbidden by axioms 1 and 4
- command-loop learning and deterministic loop-waste guardrails → a harness
  concern, see `trace-driven-harness-improvement` decision, not this surface

## Peer Lens: What The Current `headroom` Surface Gets Right

Verdict vocabulary matches the peer-distilled RFC: **COVERED** (Brewva already
does this, often more strongly), **REJECT** (conflicts with an axiom; named so we
do not re-litigate it), **BORROW** (genuine residue this RFC acts on),
**OUT OF SCOPE** (real but owned by a different theme).

| `headroom` mechanism                                                                                                         | Verdict                                  | Rationale / where it lands                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `#856` net-cost mutation formula `ΔT·(w+r(R−1)) − P_alive·(w−r)(S+ΔT)`, applied by the proxy to mutate cached messages       | REJECT (as control) / BORROW (as math)   | Runtime mutating cached context on the model's behalf violates axiom 1. The economic _model_ is the residue → **Loop 1** (graded evidence, not a mutation).                                      |
| break-even reads `R = ((w − r) / r)·(S / ΔT)` (solving the net formula at `P_alive=1`; `headroom`'s 11.5 = `(1.25−0.1)/0.1`) | BORROW                                   | Quantifies the `wasteful` threshold and turns the Loop 4 posture from "reset observed" into "N reads of headroom remain" → **Loop 1** + **Loop 3**.                                              |
| `P_alive` decay from idle time toward cache TTL (penalty vanishes near lapse)                                                | BORROW                                   | The one genuinely new physics input — Brewva records per-sample `timestamp` but never derives an idle-decayed cache-survival probability → **Loop 1** term, **Loop 3** recommendation.           |
| price multipliers `w`/`r` (write/read cost relative to base input)                                                           | BORROW (as pricing metadata)             | These are price weights, not token ratios; Brewva must source them from provider pricing/capability metadata, never infer them from `cacheWriteTokens`/`cacheReadTokens` volumes.                |
| CCR: cache originals, serve compressed, redeem via `<<ccr:HASH>>` marker                                                     | COVERED                                  | Tape is the single truth; the original is always recoverable by replay. Reversible-references RCR re-homed this already, and tape-anchored reversal is strictly stronger than a side cache.      |
| probe-based retention scoring (retained / recoverable / lost) on real sessions                                               | COVERED (as algebra) / BORROW (as grade) | Brewva already correlates post-compaction warm/reset observations; the three-way classification is the certainty signal the honesty grade reads → **Loop 2**.                                    |
| three-tier measurement honesty (measured A/B holdout / estimated synthetic control / direct property)                        | **BORROW**                               | The keystone. Brewva has the control arm on tape but never labels a verdict's certainty → **Loop 2**. This is axiom 7 on the verdict.                                                            |
| reread-waste / re-issued-identical-tool-call detection                                                                       | BORROW (thin)                            | A real objective iteration fact, but its home is the attention RFC's retention surface, not the economic verdict; this RFC only consumes it as a `measured`-grade input where it already exists. |
| durable savings ledger (append-only JSONL, cost computed at write time)                                                      | COVERED                                  | Tape is the durable log; `compactionGenerationCostUsd` already records cost at write. The cost-observability decision owns this surface.                                                         |
| verbosity shaper: append a steering block after `cache_control` to shrink model output                                       | REJECT                                   | Runtime injecting instructions to shape the model's output owns the thought path (axiom 4). Output verbosity is model-owned attention; expose budget physics, never a prompt mutation.           |
| effort routing: lower model `effort` on mechanical (`tool_result`-only) turns                                                | REJECT (as default)                      | Runtime steering reasoning depth is a thought-path decision. It may live as a model-native hint, never a runtime-injected default.                                                               |
| Python→Rust parity harness (125 fixtures lock dual implementations)                                                          | COVERED                                  | Brewva's fitness and golden-test discipline already enforces single-source-of-truth dual-surface parity.                                                                                         |

The honest answer to "what is worth learning from this wave": **the economic math
and the honesty grade.** Everything else is already covered, already re-homed, or
axiom-rejected. The two borrows below are evidence-side only.

## Decision Options: Two Evidence Closures And One Recommendation Sharpening

Runtime decision points added by this entire RFC: **0**. Loops 1 and 2 are typed
fields on an evidence record computed by pure helpers; Loop 3 is a config-time
recommendation extension. The gate that consumes pressure is unchanged. Loop 1
adds **no new recorded quantity**: both economics inputs derive from the
`fromTokens` / `toTokens` already on every committed compaction event (see its
resolution below), so every commit path is covered automatically.

### Loop 1 — Quantified net-reuse value on the economic verdict

Today `ContextEvidenceEconomicVerdict` is `{ kind, reason, metrics }` where
`metrics` is an untyped `Record<string, number | null>`, and `wasteful` is
asserted from a cache-creation-ratio threshold in `buildCompactionEconomicVerdicts`
without a single net figure.

Proposal: add a typed `netReuseValue: number | null` (token-equivalent units) and
an auditable `netReuseInputs` bag, computed by a pure helper from a Brewva-native
adaptation of `headroom`'s net-cost model:

```text
netReuseValue = ΔT·(w + r·(R − 1))  −  pAlive·(w − r)·(S + ΔT)

break-even (pAlive = 1, netReuseValue = 0):  R = ((w − r) / r)·(S / ΔT)
  (derivation: ΔT·r·R = (w − r)·S; headroom's 11.5 = (1.25 − 0.1)/0.1 confirms)

ΔT     = fromTokens − toTokens (tokens the compaction freed)
S      = toTokens (the retained post-compaction context that re-caches under the
         changed prefix) — see the resolution below
w, r   = provider cache WRITE / READ price multipliers relative to base input
         (e.g. Anthropic 1.25 / 0.1), from provider pricing/capability metadata.
         NOT inferred from cacheWriteTokens / cacheReadTokens — those are volumes,
         not price weights. Absent metadata, netReuseValue stays null (no hardcoded
         constant fallback — that is headroom's fragility).
R      = expected remaining reads of the suffix before TTL lapse  [see Open Questions]
pAlive = max(0, 1 − idleSeconds / providerTtlSeconds)
         idleSeconds from inter-turn sample `timestamp` deltas; TTL source open
```

Resolution (implemented in Phase 1): the original sketch proposed recording a new
cut-point suffix quantity, but review found that path covered only the
`session_compact` replay route and missed the primary live commit — the hosted
compaction controller commits directly via `commitRuntimeSessionCompaction`. Both
inputs instead derive from fields **already recorded on every committed event**:
`ΔT = fromTokens − toTokens`, and `S = toTokens` (after a cut the whole retained
context — summary plus kept tail — sits under a changed prefix and re-caches, so
the invalidated suffix is the post-compaction total). This covers every commit
path with no new recorded quantity, and resolves the reviewer's "S is not
reconstructable" concern by choosing an S that is. Until both token counts are
present, `netReuseValue = null`. Refining `S` to the cut-point tail (excluding the
summary) remains a future option (Open Questions).

The Brewva-native sharpening over `headroom` is that the value carries
`netReuseInputs` so it is reproducible and diffable, and that it never fabricates
certainty: missing `S`, missing `w`/`r` pricing, or missing observation each yield
`netReuseValue = null` rather than a number. When all inputs are present, the
verdict's `wasteful` meaning becomes `netReuseValue < 0` (the cut cost more cache
than it freed). The value is evidence on the verdict — rendered in inspect and
available to the model's attention surface — and never a runtime mutation trigger.
The helper is pure and deterministic from receipts plus pricing metadata; nothing
in the kernel commitment path reads it (axioms 1, 2, 18: descriptive evidence
derives views, never an unbypassable gate).

### Loop 2 — Per-verdict provenance and honesty grade (the keystone borrow)

Add to every `ContextEvidenceEconomicVerdict` a provenance key and a grade:

```text
source: { kind, compactId | reductionTurn, observationTurn }
grade:  "measured" | "estimated" | "inconclusive"

measured      the verdict's OWN provider_cache_observation (joined by source)
              confirms or refutes its expectation
estimated     a predicted-only signal (expected cache break, predicted growth)
              with no joined post-event observation yet
inconclusive  sample below floor, or null inputs / netReuseValue — axiom 7: the
              system says "not enough evidence yet"
```

This is `headroom`'s three-tier honesty model mapped onto evidence Brewva already
records: `measured` is the A/B-holdout analogue (a real observation, not a
prediction), `estimated` is the synthetic-control analogue, `inconclusive` is the
honest floor.

Implemented (Phase 2): rather than read the aggregate
`correlatePostCompactionCacheObservations` counts (which have no per-verdict
identity), each per-cut verdict joins its own compaction `timestamp` to the next
`provider_cache_observation` via `nextProviderCacheSampleAfter`. An observation is
**informative only when its status is `cold`/`warm`/`break`**; `limited` means
cache accounting was unavailable, so it neither confirms nor refutes and never
promotes a verdict to `measured`. The grade is then: `measured` when an informative
observation joins (its `turn`, `status`, `expected`, and `reason` are recorded on
`source` so confirm-vs-refute is auditable); `estimated` when economics resolved
(`netReuseValue` present) but no informative observation followed; `inconclusive`
when even the economics did not resolve. Narrower invariant: a `measured` grade
requires a tape-anchored informative `provider_cache_observation` joined to this
verdict's `source` — never a prediction, an aggregate count, or a `limited` sample.
`Evidence that cannot prove itself must say so.` Deferred: a minimum-observation
**sample floor** (shared with the Loop 4 `insufficient_evidence` floor) before a
single observation counts as `measured` — v1 treats one informative observation as
sufficient (see Open Questions).

Verdict identity is **`compactId` + `kind`**, emitted as a flat verdict array (not
folded into a per-kind map), so a session with several losing compactions yields
several `wasteful` verdicts and the aggregate counts are accurate. Receipts are
deduplicated by `compactId` first, so one compaction surfacing as both a legacy
`session_compact` and a committed event is counted once.

### Loop 3 — Break-even and idle-decay sharpening of `--recommend`

The peer-distilled RFC's Loop 4 already ships `report:context-evidence --recommend`
emitting `{ posture: hold | review | insufficient_evidence, observedCacheResetRatio,
currentAdvisoryRatio, … }` through the pure `deriveContextEvidenceRecommendation`.
It is honest but coarse: `correlatePostCompactionCacheObservations` returns only
`{ observed, warm, reset }` counts, so the recommendation reports that resets were
observed, not how much headroom remains or why a reset happened.

Proposal: extend the same pure helper (no new command, no auto-apply) with two
quantified fields derived from Loop 1's model over the aggregate:

```text
breakEvenReads      R = ((w − r)/r)·(S/ΔT) at the observed advisory ratio — how
                    many suffix reads the current ratio buys before a cut stops paying
idleDecayAtReset    the pAlive value at the idle time where resets cluster — did the
                    cache reset because the ratio is wrong, or because the session
                    simply idled past TTL (a non-actionable cause)?
```

Prerequisite: computing `idleDecayAtReset` needs the reset _distribution_, not a
count — the per-reset idle time (join each reset observation to its preceding
cut's `timestamp`), the TTL source, and a reset-reason breakdown. None of that is
retained today. So Loop 3 is gated on widening the correlation to keep that
distribution.

On a high-idle reset cluster, the proposed posture is to **attach an
`idle_ttl_likely` cause** rather than silently flipping the posture to `hold`, so
a genuinely high reset rate is never masked by an idle explanation — but whether to
change posture or only annotate the cause is an open question below. The pure
policy stays pure; only the recommendation config inputs become evidence-derived,
adopted by an operator as a reviewed edit.

Explicitly rejected variant (unchanged from peer-distilled Loop 4): closing the
loop _inside the runtime_ so the policy reads `netReuseValue` and self-tunes
mid-session. That makes the policy a stateful owner and re-introduces a hidden
attention editor. The loop stays closed at config time, under review.

## Landing Plan

Three phases, ordered so the operator-visible verdict distribution does not shift
during calibration:

1. **Math + provenance, no verdict change.** (Done.) Fix the break-even formula;
   derive `S = toTokens` and `ΔT = fromTokens − toTokens` from already-recorded
   fields; add the `source` provenance key; emit `netReuseValue` + `netReuseInputs`
   alongside the existing verdicts. The old `wasteful` heuristic count keeps running
   unchanged — operators see no distribution shift while the new figures are
   validated against it.
2. **Grade.** (Done.) With the per-verdict `source` in place, join each verdict's
   compaction `timestamp` to its next `provider_cache_observation` and add `grade`
   (`measured` / `estimated` / `inconclusive`). Still parallel to the old `wasteful`
   count.
3. **Migrate `wasteful`.** (Done.) `wasteful` is redefined as the per-cut
   `netReuseValue < 0` verdict (carrying `compactId`, `grade`, and the net figure),
   replacing the aggregate cache-creation-ratio heuristic; the report schema bumps
   to `v3`. Note: the old heuristic measured generation-cost waste (the summary call
   writing too much cache) — a distinct signal that is intentionally dropped by this
   migration. The real-trace calibration comparison against the old heuristic remains
   the promotion-to-decision gate (it cannot run in an autonomous pass).

## Source Anchors

- Economic verdict type and producer:
  `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence/types.ts`
  (`ContextEvidenceEconomicVerdict`, `ProviderCacheObservationEvidenceSample`,
  `ContextEvidenceSessionReport.economicVerdicts`),
  `buildCompactionEconomicVerdicts` (dedup-by-kind `Map`; `wasteful` from a
  cache-creation-ratio heuristic) in
  `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`
- Control arm (aggregate today, needs per-verdict join for Loop 2):
  `correlatePostCompactionCacheObservations` (returns `{ observed, warm, reset }`)
  and `ContextEvidenceSessionReport.{postCompactionCacheWarmObservations,
postCompactionCacheResetObservations}` in the same file
- Pure policy and budget derivation (unchanged; consumer of none of this):
  `packages/brewva-substrate/src/context-budget/api.ts` (`decideCompaction`)
- Pure net-reuse model (Phase 1, implemented):
  `packages/brewva-substrate/src/context-budget/compaction-economics.ts`
  (`computeNetReuseValue`, `compactionBreakEvenReads`)
- Cache cost multipliers from model pricing (Phase 1, implemented):
  `resolveCacheCostMultipliers` in `packages/brewva-provider-core/src/catalog/index.ts`
- Per-verdict economics wiring (implemented): `buildCompactionEconomicVerdicts`
  (per-cut verdict array, `compactId` dedup) plus `buildSessionCacheCostTimeline` /
  `resolvePricingFromTimeline` (per-compaction pricing) in the context-evidence surface
- Recommendation helper (Loop 3 anchor):
  `deriveContextEvidenceRecommendation` (context-evidence surface),
  `script/report-context-evidence.ts`
- Inspect render of verdicts and recommendation:
  `packages/brewva-cli/src/operator/inspect/context-cockpit.ts`,
  `packages/brewva-cli/src/operator/inspect/output.ts`
- Peer precedent (read-only, external repo, not repo-owned paths): `headroom`'s
  `#856` net-cost mutation formula and break-even, `P_alive` idle decay,
  probe-based retention scoring, and the three-tier (measured / estimated /
  direct) savings honesty model

## Validation Signals

- Loop 1: with all inputs present, a compaction that frees fewer tokens than it
  costs in cache rewrite produces `netReuseValue < 0`; a large shave under a small
  invalidated suffix produces `netReuseValue > 0`. The pure helper supports
  `pAlive` (a near-TTL idle cut with `pAlive ≈ 0` drops the penalty term — unit
  tested), but production uses `pAlive = 1` (conservative full penalty) until the
  idle-decay derivation lands with Loop 3. A missing `S`/`ΔT` (token counts) or
  missing `w`/`r` pricing yields `netReuseValue = null` and no fabricated verdict.
  `netReuseInputs` reproduces the value exactly. Unit-test the pure helper against
  golden token figures, the way `compression_policy` parity tests pin `headroom`,
  including the corrected break-even `R = ((w−r)/r)·(S/ΔT)`.
- Loop 2: a verdict whose `source` joins to a confirming
  `provider_cache_observation` grades `measured`; a predicted-only verdict with no
  joined observation grades `estimated`; a null-input or below-floor verdict grades
  `inconclusive`. No verdict claims `measured` from an aggregate count or a
  prediction.
- Loop 3: `--recommend` echoes `breakEvenReads` and `idleDecayAtReset`; a reset
  cluster at high idle is annotated `idle_ttl_likely` (and, per the open question,
  either holds posture or only annotates); a reset cluster at low idle with few
  break-even reads reads as `review`. The record stays reproducible from the same
  report aggregate and never auto-writes config.
- Landing: through phases 1–2 the existing `wasteful` count is byte-for-byte
  unchanged on a fixed trace; only phase 3 changes it, behind the v3 bump.

## Surface Budget

Counts are for the context/compaction evidence surface only; before → after.

- Required authored (model-facing) fields: 0 → 0. Net-value, inputs, source, and
  grade are runtime-derived evidence, never model-authored.
- Evidence record fields: `ContextEvidenceEconomicVerdict` gains `netReuseValue:
number | null`, `netReuseInputs` (the `{ ΔT, S, w, r, R, pAlive }` bag), and
  `source` in Phase 1 (+3 typed fields, additive); `grade` lands in Phase 2 (+1).
  `source` carries `compactId` plus, for a `measured` verdict, the joined
  observation's `observationTurn`/`observationStatus`/`observationExpected`/
  `observationReason` so the measurement is auditable. The recommendation record
  would gain `breakEvenReads` and `idleDecayAtReset` (Loop 3, not implemented).
- Routing / control-plane decision points: 1 → 1 (**+0**). The compaction gate is
  unchanged; nothing new reads `netReuseValue` to gate a turn.
- Config keys: +0 confirmed. Loop 3 reuses the existing `--recommend` opt-in; a
  break-even floor constant is conditional and window-independent if added.
- Public CLI surfaces: +0 new commands (Loop 3 extends the existing
  `report:context-evidence --recommend` JSON only).
- Persisted formats: **+0 recorded quantities.** Loop 1 derives `ΔT` and `S` from
  the `fromTokens` / `toTokens` already on every committed compaction event, so no
  new field is captured at compaction time. The verdict's new optional fields landed
  additively on `brewva.context_evidence.report.v2` through phases 1–2; the report
  schema is now `v3`, the bump that signals phase 3's `wasteful` redefinition (the
  per-cut `netReuseValue < 0` verdict replacing the aggregate heuristic).

The +0 runtime-decision-point claim is the point: the entire RFC lands on the
evidence and recommendation surfaces. Economics become legible and self-grading;
the decision to compact stays exactly where it is — with the model, gated by the
unchanged pure policy.

## Promotion Criteria And Destination Docs

Promote a loop only when its validation signals pass against a green
`bun run check` and the full suite.

- Loop 1 net-value model, Loop 2 grade → `docs/journeys/internal/context-and-compaction.md`.
- Loop 2 grade vocabulary, `wasteful`-as-`netReuseValue<0` semantics →
  `docs/reference/runtime.md`.
- Loop 3 recommendation fields and any break-even floor →
  `docs/reference/configuration.md`.

On acceptance, convert this note to a single-decision record under
`docs/research/decisions/` and supersede the relevant qualitative-verdict lines in
the context-OS decision rather than leaving a shadow reference.

## Open Questions

- `S` authority: Phase 1 uses `S = toTokens` (the full retained post-compaction
  context). Should it instead be the cut-point tail excluding the summary (a
  smaller, more favorable S), and is the extra precision worth recording the
  cut-point tokens the derivation currently avoids?
- `w`/`r` source (resolved): pricing comes from the model catalog (`cost`), failing
  closed to `null` (no hardcoded default) when missing, negative, or when `w ≤ r`.
  Pricing is resolved **per compaction at its own timestamp** (the latest
  `model_select` at or before it), not once per session, so a mid-session model
  change does not reprice older compactions. Open: whether to also record the
  provider/model/cost basis on the compaction receipt instead of deriving it from
  the `model_select` timeline — the receipt approach is more replay-stable but
  changes the persisted format (the timeline approach, chosen here, does not).
- `grade` granularity (resolved): Phase 2 grades per verdict, joined to one
  **informative** observation (`cold`/`warm`/`break`); `limited` is always
  non-confirming. Still open: the `inconclusive`/`measured` **sample floor** — should
  `measured` require N observations, shared with the peer-distilled Loop 4
  `insufficient_evidence` floor? v1 treats one informative observation as sufficient.
- `R` default: what conservative fixed value, and when is it allowed to be inferred
  from observed inter-turn cadence?
- `pAlive` TTL source: rendered `cachedContentTtlSeconds`, the cache-break-detector
  thresholds, or a provider default? How is a mixed 5m/1h cache handled?
- Loop 3 high-idle reset: flip the posture to `hold`, or only attach an
  `idle_ttl_likely` cause so the true reset rate is not masked?

## Related Work

- Accepted physics this RFC sharpens: context-OS-and-compaction-physics decision
  (economic verdicts as evidence, not replay authority).
- Prior `headroom` re-homing (compression capability): reversible-references RFC.
- Evidence-fit feedback loop this RFC extends: peer-distilled RFC, Loop 4.
- Attention selection and certainty as accountable effects: attention RFC.
- Honesty grammar: axiom 7 (`Inconclusive is honest governance`) and the aesthetic
  `Model-sovereign, tape-accountable context`.
