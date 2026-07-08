# RFC: Peer-Distilled Context Loops — Compaction Effectiveness, Reference Staleness, And The Context Ledger

## Metadata

- Status: active
- Owner: Runtime, gateway, and CLI-inspect maintainers
- Last reviewed: `2026-07-08`
- Depends on:
  - [Decision: Context Operating System And Compaction Physics](../decisions/context-operating-system-and-compaction-physics.md)
  - [RFC: Reversible References, Advisory Compression Routing, And Replay-Distilled Precedent](./rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md)
  - [RFC: Attention As An Accountable Effect](./rfc-attention-as-an-accountable-effect.md)
  - [RFC: Inspect, Replay, And Recovery Optimization](./rfc-inspect-replay-and-recovery-optimization.md)
- Promotion target:
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/configuration.md`
  - `docs/reference/runtime.md`

## Problem Statement

Brewva's context-and-compaction path is already mature: a pure `decideCompaction(...)`
policy, window-scaled budgets, a workbench the model authors itself, a mid-turn
soft-cut with bounded compaction resume, transient outbound reduction that never
touches replay truth, and an empirical `report:context-evidence` surface. The
external-precedent question ("what do `headroom`-style compression engines get
right, and how do we re-home it without the prompt-manager trap?") is answered by
the RCR / ACR / RDP RFC, and the aesthetic is already named
`Model-sovereign, tape-accountable context`.

This RFC takes a different external lens. Two other mature coding agents —
`opencode` (durable event-sourced summarization) and `hermes` (long-horizon
Python automation with aggressive compression) — solve the same problem with
different trade-offs. A disciplined pass over both shows that **most of what they
do is already covered by Brewva, or is deliberately rejected by Brewva's axioms**.
The value is in the small residue: a handful of _loops_ those peers close that
Brewva currently leaves open, even though the primitives to close them already
exist on tape.

This RFC isolates that residue into five loops and re-homes each into the ring
that already owns the authority, the same way the RCR/ACR/RDP RFC re-homed
`headroom`. It introduces no new memory editor, no context-source registry, and
no replay authority. Its one-line thesis, in the grammar the attention RFC
established (`Selection is an effect; reversal is an effect; both leave receipts`):

> Compaction must prove it shrank; a reference must prove it still resolves; and
> the derivation that decided both must be inspectable end to end.

## Scope Boundaries

In scope:

- a `compaction_ineffective` skip posture for the pure compaction policy
- render-time staleness verification of a workbench note's digest-bound `rcr`
  anchors (the live-reference companion to RCR's reversal-time verification)
- closing the deferred decision on whether the model-authored workbench is the
  **primary** surviving compaction artifact rather than a parallel summary
- closing the **evidence-fit feedback loop**: letting `report:context-evidence`
  output become evidence-derived config inputs to the (still pure) policy
- a unified, explicit-pull **context ledger** inspect line that chains the full
  derivation (window → limits → predicted growth → pressure → gate → last receipt
  → cache posture) in the shared inspect host's compaction surface

Out of scope (owned elsewhere; this RFC must not re-open):

- RCR reference design, `recall_expand`, ACR content-shape routing, RDP
  precedent distillation → reversible-references RFC
- per-entry attention receipts, `retention_hint` persistence, consume events →
  attention RFC
- cursor-bound recovery evidence and the replay/forensic split → inspect RFC
- the aesthetic name and axiom grammar → already committed to `design-axioms.md`
- any host-owned silent injection, summarization, or context-source registry →
  forbidden by the first two axioms (`Model owns attention`, `Tape owns truth`)

## Peer Lens: What `opencode` And `hermes` Get Right

Each peer technique is given a verdict against Brewva's current state. The
verdict vocabulary is deliberate: **COVERED** (Brewva already does this, often
more strongly), **REJECT** (conflicts with an axiom; named so we do not
re-litigate it), **BORROW** (genuine residue this RFC acts on).

| Peer     | Technique                                                                                             | Verdict                                   | Rationale / where it lands                                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencode | Durable `compaction` message; originals never deleted; replay from checkpoint                         | COVERED                                   | `session_compact` receipt + event tape is strictly stronger (tape is the single replay authority, not a synthetic message).                                                                                                                                                             |
| opencode | Verbatim recent tail preserved beside the summary                                                     | COVERED                                   | `tailProtectRatio` / `session-cut-point` already protect the recent tail, window-scaled.                                                                                                                                                                                                |
| opencode | Structured Markdown summary template (Goal / Constraints / Progress / Decisions / Next steps / Files) | BORROW (thin)                             | Adopt as the **render contract** for the workbench-primary artifact (Loop 3). The deeper read: opencode's `compaction` message is conceptually Brewva's compacted workbench — **the model's notebook is the summary** — so this amplifies the aesthetic rather than donating mechanism. |
| opencode | `system-context` as independently-refreshable typed sources (baseline/update/removed diff)            | REJECT (as source) / COVERED (as algebra) | A pushed context-source registry violates the no-provider-registry stance; the diff algebra is already borrowed for cache-prefix-stability evidence in the checked-invariants RFC.                                                                                                      |
| opencode | `len/4` token estimate                                                                                | REJECT                                    | Brewva has a dedicated `brewva-token-estimation` package; the flat heuristic regresses accuracy as windows grow.                                                                                                                                                                        |
| hermes   | Dual-layer threshold (gateway 85% safety net + agent 50% primary)                                     | COVERED                                   | `advisoryRatio` + `hardRatio` express the same two-stage pressure, window-scaled.                                                                                                                                                                                                       |
| hermes   | **Anti-thrashing back-off**: skip compression when the last N attempts each saved < ~10%              | **BORROW**                                | Brewva only has a 3-consecutive-_failure_ breaker; it has no "succeeded but did not shrink" guard. → **Loop 1**.                                                                                                                                                                        |
| hermes   | Tool-output pre-pruning into informative one-line placeholders before summarizing                     | BORROW (as render)                        | RCR already owns the reversible reference; the residue is a human-readable, tape-anchored digest _rendered in place_ on evict. → folded into **Loop 3**.                                                                                                                                |
| hermes   | Deterministic fallback summary when the summarizer model fails                                        | COVERED                                   | Deterministic summary projection already exists as the emergency fallback.                                                                                                                                                                                                              |
| hermes   | Compression-continuation session chain (`parent_session_id`)                                          | COVERED                                   | Session lineage + tree-history parent pointers are richer (a tree, not a single continuation chain).                                                                                                                                                                                    |
| hermes   | Iterative summary update (preserve prior summary, summarize only new turns)                           | COVERED                                   | `minTurnsBetween` cooldown + persistent workbench notes avoid re-summarizing prior summaries.                                                                                                                                                                                           |

The table is the honest answer to "what is worth learning": **opencode and hermes
mostly validate decisions Brewva already made**, which is itself a useful signal.
The genuine borrow is hermes's effectiveness guard (Loop 1) plus one rendering
idea (folded into Loop 3). The remaining loops below are not peer ports — they are
Brewva-internal closures that the peer comparison _motivates_, because both peers
ship one coherent compaction story while Brewva's equivalent is currently split
across deferred pieces.

## Decision Options: The Five Loops

Only **Loop 1 is a new runtime decision** — a single pure-policy skip branch. The
other four are render-time (Loop 2), a canonical-artifact decision closure
(Loop 3), config-time (Loop 4), and a pure projection (Loop 5). The runtime delta
of this entire RFC is one bit; that is the "minimal residue" claim made literal,
and it is what keeps the review surface small.

**Implementation state (2026-07-08):** all five loops landed v1 on `main`
(`0485dc7`, plus the Loop 1 receipt closure). Loop 1 — the `compaction_ineffective`
skip is wired in `decideCompaction` (`context-budget/api.ts`), fed by
`readAutoCompactionIneffective`, with the auto-path receipt closure done
(`hosted-compaction-controller.ts` threads `tokensBefore`→`fromTokens` and commits
`toTokens`; `compaction-totokens` test). Loop 2 — render-time staleness in
`context/workbench-staleness.ts`. Loop 3 — the workbench-primary compaction
_fallback_ in `compaction/summary-generator.ts` (the happy-path summary swap stays
benchmark-gated). Loop 4 — the `report:context-evidence --recommend` aggregate
posture in `context/evidence/context-evidence.ts` + `script/report-context-evidence.ts`
(its per-model target still deferred). Loop 5 — the context-ledger inspect line in
`operator/inspect/context-cockpit.ts` (`formatContextLedgerLine`, `context-ledger`
test). What remains is promotion (real-trace validation), not mechanism.

### Loop 1 — Compaction effectiveness guard (the hermes borrow)

Hypothesis: a compaction that completes but frees too little context is a thrash
risk, especially under the auto path. Today `decideCompaction(...)` can `skip`
for `auto_compaction_breaker_open` (three consecutive _failures_) but has no skip
for _ineffective success_.

Proposal: add one skip reason, `compaction_ineffective`, derived purely from
recent committed compaction receipts. The signal is the realized reduction ratio
`(fromTokens - toTokens) / fromTokens` of the last N consecutive receipts measured
against a configured floor — the same "N consecutive" shape the failure breaker
already uses, so the two skip reasons read as one kind of guard. The policy stays a
pure function and remains "not a stateful owner": it consumes a single boolean
`autoCompactionIneffective`, computed by a pure helper exactly the way
`readAutoCompactionBreakerOpen` feeds `autoCompactionBreakerOpen` today.

```text
skip reason: "compaction_ineffective"
input:       autoCompactionIneffective?: boolean    // mirrors autoCompactionBreakerOpen
helper:      readAutoCompactionIneffective(receipts, minShrinkRatio, minAttempts)
             receipts are newest-first; reductionRatio = (fromTokens - toTokens) / fromTokens in [0,1]
             true iff the last `minAttempts` receipts that have a usable ratio all
             reduced below `minShrinkRatio` (receipts with null/<=0 fromTokens or
             null toTokens are ignored, so missing data never blocks)
constants:   MIN_COMPACTION_SHRINK_RATIO    (reduction floor, e.g. 0.10 = remove >=10%)
             MIN_COMPACTION_SHRINK_ATTEMPTS (1; internal substrate constant, not runtime config)
guard:       only applies to caller "auto"; "manual" and "model_downshift" bypass
bypass:      hard_limit pressure bypasses it (correctness over thrash-avoidance)
```

`MIN_COMPACTION_SHRINK_ATTEMPTS` defaults to 1 — the simplest rule for a per-call
pure policy. This is _not_ "matches hermes": hermes blocks after N=2 consecutive
no-ops (`_ineffective_compression_count >= 2`). Brewva starts at N=1 and promotes
to N>=2 (by changing the internal constant, not runtime config) only if
validation surfaces single-shot noise, reusing the breaker's consecutive-count
shape so both guards stay structurally identical.

Input contract (resolved here, not deferred): the receipt authority is
`commitRuntimeSessionCompaction`'s `fromTokens` / `toTokens` pair
(`brewva-vocabulary/internal/session.ts`), which the Cockpit/Inspect projections
already render as `tokens=from->to`. Both ship as `number | null` today, and the
auto-path telemetry `emitSessionCompact` payload omits them, so two things must
close before Loop 1 lands: (1) the auto-path commits both counts — `toTokens` via
`estimateBrewvaCompactedContextTokens`, and `fromTokens` by threading the prep's
`preview.tokensBefore` onto the compaction entry (it previously fell back to a
commit-time usage read that could be null); (2) receipts lacking a usable
`fromTokens`/`toTokens` pair are ignored by `readAutoCompactionIneffective`, so the
guard fires only on positive evidence of ineffectiveness and missing data never
blocks a compaction. This is additive and projection-tolerant — a small contract
closure, not an open question.

**Landed (`0485dc7` + receipt closure):** both closures shipped. The auto path
threads `tokensBefore`→`fromTokens` and commits `toTokens`
(`hosted-compaction-controller.ts`; asserted by `compaction-totokens` test), and the
`compaction_ineffective` skip is wired in `decideCompaction` (`context-budget/api.ts`),
fed by `readAutoCompactionIneffective`.

Layering: this guard sits _after_ the existing `recent_compaction` skip, not before
it. Within the `minTurnsBetween` cooldown, `recent_compaction` already defers;
`compaction_ineffective` is the post-cooldown guard for a session that resumes
compacting yet keeps shrinking below the floor. Both resolve to a skip, so the
ordering only changes which reason is reported inside the cooldown window.

### Loop 2 — Live reference staleness (the RCR companion)

`workbench_note` already forbids source-less memory (`source_refs` required at
write time), and RCR already verifies a reference _at reversal time_ (fails closed
with `unresolvable_reference` / digest mismatch). The open loop is the time in
between: a note whose `source_refs` point at a span that was later evicted or
whose content digest drifted is silently trusted until someone tries to reverse
it.

Proposal (v1, implemented): at the workbench render seam (`buildWorkbenchBlock` in
`workbench-context.ts`), verify each note's digest-bound `rcr` anchors against the
current tape and mark a note `stale` when every anchor is broken — surfaced inline
(`stale=true`) and de-prioritized when the rendered set is capped, never deleted.

Why the `rcr` anchors and not the free-form `sourceRefs`: `WorkbenchEntry.sourceRefs`
is `readonly string[]` (model-authored quoted turns, file paths, tool/event ids) —
advisory, not digest-bound, so "does it still resolve?" cannot be answered reliably
from a sourceRef string. The verifiable surface is `WorkbenchEntry.rcr`
(`RcrReference[]`): typed, digest-bound, and resolvable by the existing
`resolveRcrReferenceAgainst`. v1 resolves those synchronously over an in-memory
event lookup (built only when some entry carries an anchor): an anchor is broken
when its event is gone (`event_unavailable`) or its content digest drifted
(`digest_mismatch`); an entry is `fresh` if any anchor resolves, `stale` if all are
broken, `unverifiable` if it has no anchors. It never reports a false `fresh` and
never deletes.

Aggregation and selection are pure (`aggregateWorkbenchEntryStaleness`,
`selectStaleAwareWorkbenchEntries`); only the event lookup touches the runtime.

Deferred (documented, not silently dropped): a `file:<path>#span` workspace-fs
verdict (workspace-derived, a distinct authority from tape — needs the mtime-vs-hash
decision in Open Questions) and a free-form-`sourceRefs` classifier remain future
work. Those refs stay `unverifiable` in v1 rather than guessing.

Cut-point interaction: staleness de-prioritizes within the **workbench block**
render (stale notes are dropped first under the render cap), which is where workbench
notes live — not the session `selectBrewvaSessionCompactionCutPoint`, whose
`branchEntries` are message history, not workbench notes. Passing a
`staleEntryIds: ReadonlySet<string>` into that pure cut-point stays an available
extension if session-entry staleness is ever needed, but v1 does not require it.

Invariant added (narrower than the shared projection discipline): a stale workbench
note is downgraded, never deleted, and its staleness is a tape-derived, inspectable
verdict — `reference resolution is an effect that leaves a receipt`.

### Loop 3 — Workbench as the primary compaction artifact (closing a deferred decision)

The reversible-references RFC explicitly defers "promoting an ACR reduction
candidate into a deterministic default-path transform" and leaves open whether the
model-authored workbench is the primary surviving artifact or a parallel track to
the `session_compact` summary. Both peers ship exactly one artifact (opencode's
`compaction` message, hermes's single summary message); Brewva today carries two
conceptual products (the workbench notebook and the compaction summary path).

Target: at the cut point the surviving model-visible context is \*\*workbench notebook

- protected tail + recall index\*\*, and the compaction "summary" is ideally the
  rendered workbench (the model's own notes), not a fresh host-driven summarization
  pass — collapsing Brewva's two artifacts into the one the _model_ authored.

v1 (implemented): the model-authored workbench becomes the **primary fallback**
artifact. When LLM summarization is unavailable (the existing failure path),
`resolveCompactionFallbackSummary` renders the workbench notebook as the summary
(strategy `workbench_primary_compaction`) and only falls back to the deterministic
projection when the workbench has no note content — the explicit fallback contract
that keeps the canonical artifact from ever being undefined (cold sessions,
brand-new turns, a model that authored no note). Both fallback branches now pass the
heuristic integrity sanitizer that the LLM path already applied, closing a real gap:
the old deterministic fallback skipped sanitization.

Gated (not done in v1): replacing a **successful** LLM summary with the workbench on
the happy path is the canonical-artifact change. It is the highest-value but
highest-risk step — it changes which artifact is canonical at the cut point
(replay-affecting) and bets that workbench + tail + recall loses no more information
than the LLM summary. The RFC requires runtime/gateway maintainer review and the
information-loss benchmark below before that switch promotes; an autonomous pass
cannot run that benchmark, so v1 stops at fallback-primary + the integrity fix and
leaves the happy-path switch to the gated promotion.

### Loop 4 — Evidence-fit ratio feedback (closing the empirical loop)

`report:context-evidence` already correlates `expectedCacheBreak` against real
`provider_cache_observation`, and `session_compact` receipts against the first
post-compaction cache observation. Today that output is _offline promotion
evidence_. The mechanism to consume it (config-driven `advisoryRatio` /
`hardRatio` / `tailProtectRatio`, all window-scaled) already exists; the loop is
simply not wired.

Proposal: an opt-in, operator-invoked job emits an evidence-fit recommendation
derived from the report, reviewed and adopted explicitly — never auto-applied into
runtime. The pure policy stays pure; only its config inputs become evidence-derived.
This is the natural extension of the empirical-promotion aesthetic.

Recommendation artifact (v1, implemented): a `report:context-evidence --recommend`
flag emits a stable JSON record `{ schema, sampleSize, observedCacheResetRatio,
currentAdvisoryRatio, currentHardRatio, currentTailProtectRatio, posture, rationale }`
where `posture` is one of `hold` / `review` / `insufficient_evidence`. It reads the
report's aggregate post-compaction cache warm/reset counts and the live config ratios
through the pure `deriveContextEvidenceRecommendation`, so the recommendation is
grounded in real evidence and diffable against the current config. It never
auto-writes; an operator adopts any ratio change as a reviewed config edit.

Honest scope (corrected from the original sketch): v1 emits an **aggregate** posture
recommendation, not a per-model record with a specific recommended ratio. Cache
observations do not yet carry a model id, and the report does not record the usage
ratio at which a reset occurs, so a per-model "reset at 0.82 → advisory 0.78" formula
cannot be grounded today (see Open Questions). v1 surfaces the observed reset ratio,
the current ratios, and a conservative posture rather than fabricating a target
number; per-model breakdown and a computed target ratio are deferred to the substrate
work that would tag cache observations with a model id.

Why this is the future-model loop: as context windows grow, a fixed advisory ratio
under-utilizes headroom unless it is recalibrated per model. This is the one loop
that improves automatically as new models land, and it is the cleanest
demonstration that `model-sovereign + tape-accountable + empirical promotion` beats
peers' fixed thresholds (opencode's `len/4` + 20k buffer; hermes's 50/85% pair)
without surrendering the pure-policy invariant.

Explicitly rejected variant: closing the loop _inside the runtime_ (the policy
reads evidence and self-tunes mid-session). That would make the policy a stateful
owner and re-introduce a hidden memory editor. The loop is closed at config time,
under review, by design.

### Loop 5 — The context ledger (unifying scattered inspect surfaces) — v1 landed

The derivation that produces a gate decision is spread across the Work Card,
context-evidence reports, and `decideCompaction` inputs. No single surface shows
the whole chain. Operators reconstruct it by hand — and even a capable reviewer
mis-located the gate-enforcement site during this RFC's own research, which is
direct evidence that the derivation locus is under-surfaced.

Proposal: extend the focused compaction inspect surface (`formatInspectCompactionText`
in `operator/inspect/output.ts`) — part of the shared inspect host, per the inspect
RFC's "extend, don't add a dashboard" rule — with one **context ledger** line. It
renders directly from the `ContextCockpitReport` (where the gate's `status` already
lives) instead of copying budget fields into the task Work Card projection, so it
stays a pure projection of the gate's own inputs with no duplicated surface:

```text
Context ledger: window=200000 advisory=156000(0.78) hard=184000(0.92) growth=12000 usage=171200(0.86) pressure=predicted_overflow gate=armed:predicted_overflow lastReceipt=compact#abc cache=reset
```

`pressure` is status-derived (`forced` / `predicted_overflow` / `advised` / `ok`)
while the gate `reason` is the policy vocabulary (`hard_limit` / `usage_threshold` /
…); they are two deliberate vocabularies, so a forced turn reads
`pressure=forced gate=armed:hard_limit`.

It inherits the shared projection discipline verbatim (deterministic from
receipts, rebuildable, explicit-pull, never auto-pushed into model context, fails
closed to a blocked posture). It adds one narrower invariant: the ledger renders
only values already derivable from tape and the pure budget functions — it
computes nothing new, so it can never disagree with the policy that gated the
turn.

Standing fitness (asserted, not just promised): for any gated turn, the ledger
value at each stage equals the policy input the gate used at that stage — a
replay-equivalence test over the same receipts. If the ledger and the gate ever
disagree, the ledger is wrong by construction.

Aesthetic note: the ledger is not only an operator surface. By making the gate
derivation legible it becomes the receipt the _model_ can rely on — which is what
makes `Model owns attention` survivable under pressure: the model can trust why a
tool was gated instead of guessing at it.

## Source Anchors

- Pure policy and budget derivation: `packages/brewva-substrate/src/context-budget/api.ts`
  (`decideCompaction`, `deriveContextBudgetState`, `resolveWindowScaledTokens`,
  `readAutoCompactionBreakerOpen`)
- Token-aware cut point: `packages/brewva-substrate/src/compaction/session-cut-point.ts`
- Compaction gate enforcement (Loop 5 anchor; non-obvious locus):
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-context-budget.ts`
  (`checkGate`), applied in
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/tools.ts`
  (`gateBlocked`)
- Workbench tools and `source_refs` requirement:
  `packages/brewva-tools/src/families/memory/workbench.ts`
- Workbench render / dynamic tail and staleness annotation:
  `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
- Workbench reference staleness (pure):
  `packages/brewva-gateway/src/hosted/internal/context/workbench-staleness.ts`
- Evidence sidecar, report, and `--recommend` recommendation:
  `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`
  (`deriveContextEvidenceRecommendation`), `script/report-context-evidence.ts`
- Hosted controller (auto path state): `packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.ts`
- Workbench-primary compaction fallback (Loop 3): `renderWorkbenchCompactionSummary` /
  `resolveCompactionFallbackSummary` in
  `packages/brewva-gateway/src/hosted/internal/compaction/summary-generator.ts`, wired
  at the LLM-failure path in
  `packages/brewva-gateway/src/hosted/internal/session/managed-agent/compaction-lifecycle.ts`
- Work Card inspect surface: `packages/brewva-cli/src/operator/inspect/output.ts`,
  `packages/brewva-cli/src/operator/inspect/work-card.ts`
- Peer precedent (read-only, external repos, not repo-owned paths): opencode's
  overflow-triggered `compactIfNeeded` summarization; hermes's `should_compress`
  threshold and its ineffective-compression back-off

## Validation Signals

- Loop 1: on a thrash-prone trace (repeated near-threshold turns), the auto path
  stops re-requesting after N consecutive ineffective receipts (N=1 default);
  `hard_limit` still bypasses; a null-`toTokens` receipt is ignored (never counted as
  effective); no regression in a normal compaction trace. Unit-test
  `decideCompaction` with low shrink ratios across all three callers.
- Loop 2: a note whose `rcr` anchor event is gone or whose content digest drifted
  renders `stale=true` and is dropped before live notes when the workbench block is
  capped; a note with a live, digest-matching anchor stays `fresh`; a note with no
  anchor is `unverifiable` (never a false `fresh`).
- Loop 3 (v1): when LLM summarization fails and the workbench has note content, the
  fallback summary is the rendered workbench (`workbench_primary_compaction`); with
  no note content it is the deterministic projection; both are integrity-sanitized.
  Unit-tested via `renderWorkbenchCompactionSummary` / `resolveCompactionFallbackSummary`.
- Loop 3 (gated happy-path switch): before replacing a successful LLM summary, prove
  measured information loss is no worse than the current summary path on a benchmark
  set and that replay equivalence + cache-prefix stability hold. This benchmark is
  the promotion gate an autonomous pass cannot run.
- Loop 4: `--recommend` emits `review` once the post-compaction reset ratio crosses
  the threshold with a sufficient sample, `hold` when the cache stays warm, and
  `insufficient_evidence` below the sample floor; current ratios are echoed for
  diffing and the record is reproducible from the same report aggregate.
- Loop 5: the ledger value for every stage equals the value the policy used to
  gate the turn (assert the ledger is a pure projection of the same inputs);
  opening the ledger triggers no recall, materialization, or workbench mutation.

## Surface Budget

Counts are for the context/compaction surface only; before → after.

- Required authored (model-facing) fields: 5 → 5 (no new required tool params;
  `workbench_note.source_refs` already required).
- Optional authored fields: 0 → 0.
- Author-facing concepts: 0 net new. Effectiveness and staleness are
  runtime/operator-derived, not model-authored; "workbench-primary artifact" is a
  reframing of existing concepts, not a new one.
- Inspect surfaces: 0 new mount points. The context ledger is one new _line_ in
  the focused compaction inspect surface (`formatInspectCompactionText`), under the
  existing shared inspect host; it renders from `ContextCockpitReport` and adds no
  field to the task Work Card projection.
- Routing / control-plane decision points: 1 → 2 (**+1**: the
  `compaction_ineffective` skip branch in `decideCompaction`). All other loops are
  config-time (Loop 4), render-time (Loops 2, 5), or a re-definition of an existing
  artifact (Loop 3), not new runtime decision points.
- Config keys: +0 for Loop 1 — `minCompactionShrinkRatio` and
  `minCompactionShrinkAttempts` landed as internal substrate constants
  (`MIN_COMPACTION_SHRINK_RATIO` / `MIN_COMPACTION_SHRINK_ATTEMPTS`), withdrawn
  from public `infrastructure.contextBudget.compaction` per the critical-rules
  context-budget whitelist; +1 conditional remains (a Loop 4 evidence-fit opt-in
  flag). All window-independent ratios/ints/booleans.
- Public CLI surfaces: +1 (`report:context-evidence --recommend`, Loop 4),
  emitting stable JSON only; no new command.
- Persisted formats: 0 new formats. Loop 1 tightens the existing
  `commitRuntimeSessionCompaction` receipt so the auto-path commits `toTokens`
  non-null (the field already exists as `number | null`); additive/tightening,
  projection-tolerant, not a new format.

Net positive control-plane decision point (+1) justification:

- Debt owner: runtime maintainers (policy is theirs).
- Why unavoidable: the effectiveness signal is a genuinely new decision (not
  expressible by reusing the failure breaker, which only counts errors). Folding it
  into the breaker would conflate "errored" with "ineffective" and lose the
  hard-limit bypass distinction.
- Re-evaluation trigger: if validation shows single-receipt noise forces the EMA
  variant, re-evaluate whether the branch should instead be absorbed into the
  predicted-growth path. Dated trigger: revisit by `2026-09-30`.

## Promotion Criteria And Destination Docs

Promote a loop only when its validation signals pass against a green
`bun run check` and the full suite, and (for Loop 3) after runtime/gateway
maintainer review of the canonical-artifact change.

- Loops 1, 3, 4 → `docs/journeys/internal/context-and-compaction.md`
  (policy skip reason, canonical artifact, evidence loop).
- Loop 1 config, Loop 4 opt-in → `docs/reference/configuration.md`.
- Loop 1 skip-reason vocabulary, Loop 2 staleness posture →
  `docs/reference/runtime.md`.

On acceptance, convert this note to a single-decision record under
`docs/research/decisions/` and supersede the relevant deferred lines in the
reversible-references RFC rather than leaving a shadow reference.

## Open Questions

- Loop 2: v1 verifies only digest-bound `rcr` anchors. Extending to free-form
  `sourceRefs` (turn/event/tool) and to a `file:<path>#span` workspace verdict is
  future work; the workspace check is least settled — what counts as "changed"
  (mtime, content hash, or both), and how is that authority kept distinct from tape?
- Loop 3: when the workbench is the canonical artifact, what is the minimum tail
  that must survive untouched so a non-converging turn can still make progress?
  This intersects the soft-cut resume bound (`compaction_resume_attempts_exhausted`).
- Loop 4: per-model evidence-fit needs cache observations tagged with a model id
  (not recorded today) and the usage ratio at which a reset occurs before a computed
  per-model target ratio is groundable; v1 stays aggregate. What sample floor and
  reset-ratio threshold best avoid over-fitting a short trace?

## Related Work

- Re-homing external compression authority: reversible-references RFC (RCR/ACR/RDP).
- Attention selection as accountable effect; aesthetic naming: attention RFC.
- Cursor-bound recovery evidence and replay/forensic split: inspect RFC.
- Disciplined peer borrowing precedent (opencode diff algebra, tool-identity
  guard): checked-invariants RFC.
- Accepted physics this RFC builds on: context-OS-and-compaction-physics decision.
