# Active Research Notes

`docs/research/active/` holds incubation work that still has open validation or
contract questions. Keep each note focused enough that it can become an
accepted decision or be archived on its own instead of turning back into a
catch-all roadmap file.

Read `docs/research/README.md` for lifecycle rules. Use this directory when you
need the current open questions, source anchors, and promotion criteria for an
active theme.

Governance rule: `active/` is for unresolved design work only. When the target
stable docs already carry the accepted contract, convert the note to
`docs/research/decisions/` rather than keeping it as a shadow reference.

## Shared Projection Discipline

Projection-bearing active notes share one product discipline:

- projections are deterministic from receipts and declared read-model evidence
- projections are rebuildable and never become replay truth
- projections do not widen kernel, capability, source, or adoption authority
- inspect views are explicit-pull and must not auto-push into model-visible
  context
- bundle inspect views should mount under one shared inspect host with common
  navigation, filters, redaction, and cross-view linking
- opening a projection must not trigger recall, capability selection,
  materialization, provider routing, workbench mutation, or background delivery
- rendering reuses existing redaction layers and never expands raw command,
  environment, credential, or secret-bearing text
- projection failure fails closed to an inspectable blocked, denied, or ask
  posture instead of silently rendering broader authority

RFC-specific documents should only add narrower invariants on top of this shared
discipline.

## Current Active Notes

- [RFC: Inspect, Replay, And Recovery Optimization](./rfc-inspect-replay-and-recovery-optimization.md):
  active RFC for replacing optimistic recovery status with cursor-bound
  evidence, separating authoritative replay from forensic scanning, converging
  rewind/redo on one gateway-owned transaction engine, and proving zero-cache
  replay equivalence without widening the four-port runtime.
- [RFC: Reversible References, Advisory Compression Routing, And Replay-Distilled Precedent](./rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md):
  active RFC for re-homing external context-compression capabilities into
  Brewva's authority model: tape-anchored byte-exact reversible references for
  evicted spans (RCR), deliberation-ring advisory reduction candidates with a
  bounded emergency cut-shape hint (ACR), and an opt-in control-plane job that
  distills failure precedent from the session index into explicit-pull
  `docs/solutions/**` records (RDP). Resolves the recall-versus-summary
  fact-ownership question tracked by the context-OS RFC.
- [RFC: Attention As An Accountable Effect](./rfc-attention-as-an-accountable-effect.md):
  active RFC for closing the last gap in typed, per-entry, promotion-grade
  attention-selection evidence: making attention selection an accountable effect
  on top of today's generic metrics (persisting the dropped `retention_hint`,
  adding a typed consume event and per-entry projection, promoting eviction
  strings to vocabulary constants), a taxonomy-gated verify-only attention-budget
  commitment, and a retention dashboard; feeding the reversible-references RDP
  promotion path rather than adding a second one; and naming the cross-RFC
  grammar (`Selection is an effect; reversal is an effect; both leave receipts`)
  and the aesthetic (`Model-sovereign, tape-accountable context`) for
  `design-axioms.md`. Surface amplification is a non-blocking follow-up.

- [Axiom Negative-Space Linkage And Decisions Demotion](./axiom-negative-space-and-decisions-demotion.md):
  active note for connecting the existing normative gradient (`design-axioms` ->
  `critical-rules` -> `anti-patterns`) instead of adding a new anti-patterns doc.
  Delivered as per-rule `(axiom N)` source tags in the project rule docs plus a
  generated `docs/reference/axiom-enforcement.md` view (derived from those tags
  the way `skill-navigation.md` is derived from skill bodies) that surfaces
  unenforced axioms as visible negative space, guarded by a regenerate-and-diff
  fitness, with a one-line `decisions/` pointer. No hand-authored map and no new
  anti-patterns doc; `decisions/` stays immutable and in place.

- [RFC: Checked Invariants And Disciplined Peer Borrowing](./rfc-checked-invariants-and-disciplined-borrowing.md):
  active RFC for upgrading load-bearing runtime invariants from documented
  promises to checked artifacts — coarse-bucket phases for the hosted
  turn-lifecycle-port array, a generated `capability x plugin` matrix plus an
  allowlist fitness guarding the no-context-source invariant (context-write
  capabilities `== {context_messages.write}`) and a `hosted_behavior`
  capability-set drift guard, an explicit replay-contract boundary for the hosted
  lane's parallel message assembly (which does not pass through `materialize()`),
  a reachability-gated in-flight tool-identity guard, and removal of a dead
  placeholder — and for disciplined peer borrowing (`opencode`'s snapshot diff
  algebra into materialization cache stability, `pi-mono`'s call/result rendering
  ergonomics into the advisory ring) under the line `Borrow the mechanism, never
the authority shape`.

- [RFC: Peer-Distilled Context Loops — Compaction Effectiveness, Reference Staleness, And The Context Ledger](./rfc-peer-distilled-context-loops.md):
  active RFC distilling the residue from two mature peers (`opencode`,
  `hermes`) after most of their compaction techniques prove already-covered or
  axiom-rejected: a `compaction_ineffective` skip posture for the pure policy
  (the hermes anti-thrashing borrow), render-time staleness verification of a
  workbench note's digest-bound `rcr` anchors (the live-reference companion to
  RCR's reversal-time check), making the model-authored workbench the primary
  compaction _fallback_ artifact (the happy-path summary switch stays gated on a
  benchmark), closing the evidence-fit feedback loop as a reviewed aggregate
  `report:context-evidence --recommend` posture while the policy stays pure, and
  one unified explicit-pull context-ledger line in the shared inspect host's
  compaction surface. Under the grammar `Compaction must prove it shrank; a
reference must prove it still resolves`.

- [RFC: Transcript As A Single Ordered Truth Source](./rfc-transcript-single-ordered-truth-source.md):
  RFC (landed) collapsing the CLI transcript onto a single ordered truth
  source — wire-fold's `snapshot.transcriptMessages` — so `refreshFromWireFold`
  degrades from per-message-type splicing to `replaceMessages(snapshot)` plus a
  CLI-only rewind overlay. Custom messages become a gateway-origin
  `custom.message` wire frame; free-floating messages stay optimistic
  placeholders replaced wholesale by the snapshot, retiring the projector-level
  multi-turn-ordering patches.

- [RFC: Quantified Compaction Economics And Graded Evidence Honesty](./rfc-quantified-compaction-economics-and-evidence-honesty.md):
  active RFC taking a third pass at `headroom` — its current `#856` net-cost arc
  and counterfactual-savings wave, none of which existed when the
  reversible-references and peer-distilled RFCs were written. The disciplined read
  finds the same pattern: most of the new surface is COVERED (CCR weaker than tape,
  savings ledger weaker than cost-observability) or REJECTED (the proxy mutating
  cached messages, the verbosity shaper, effort routing — all runtime seizing
  attention or thought-path, axioms 1/4). The genuine residue is two evidence-side
  closures Brewva has the category for but not the rigor: a typed quantified
  `netReuseValue` (plus an auditable `netReuseInputs` bag) on the economic verdict
  — a Brewva-native adaptation of the net-cost formula with the corrected
  break-even `R = ((w−r)/r)·(S/ΔT)`, provider-priced `w`/`r` multipliers (not token
  ratios), and an idle-decayed `pAlive`, making `wasteful` mean `netReuseValue<0` —
  and a `measured`/`estimated`/`inconclusive` honesty grade joined per-verdict to a
  specific cache observation (axiom 7 made literal), plus a break-even/idle-decay
  sharpening of the peer-distilled `--recommend` posture. Both economics inputs
  derive from already-recorded fields (`ΔT = fromTokens − toTokens`, `S = toTokens`),
  so every commit path is covered with no new recorded quantity; a phased landing
  bumps the report schema to v3 when the semantics migrate. All three phases are
  implemented: 1 (pure net-reuse model + pricing multipliers + per-verdict
  provenance), 2 (per-verdict honesty grade joined to a cache observation), and 3
  (`wasteful` redefined as the per-cut `netReuseValue < 0` verdict, schema → v3,
  replacing the aggregate generation-cost heuristic). Loop 3 (the `--recommend`
  break-even/idle-decay sharpening) stays RFC-gated on retaining the cache-reset
  distribution and is intentionally unimplemented; the real-trace calibration
  against the old heuristic is the remaining promotion-to-decision gate. Runtime
  decision points added: 0 — the gate is unchanged. Under the line `Compaction economics
inform attention; they never seize it — and a verdict that cannot prove itself
must grade itself.`

- [Candidate Axiom: Accounting For Unmeasurable Benefit](./candidate-axiom-accounting-for-unmeasurable-benefit.md):
  active candidate-axiom proposal distilling the _essence_ (not the mechanisms) of
  `headroom` — a methodology for staying trustworthy about a benefit that can never
  be directly observed (saved tokens are a counterfactual). Proposes the line
  `Unmeasurable benefit must be accounted, not asserted.` for `design-axioms.md`
  with a five-clause implementation reading (reversible action licenses aggression;
  a decision unobserved in its consequence is a guess; one currency makes
  trade-offs compose; uncertainty weakens the claim not the operation; calibration
  beats upfront correctness), extending axiom 7. Repositions the just-landed
  `netReuseValue`/`grade` work as the _first, partial_ instance (it exercises
  currency, grading, loop, and calibration in one ring but leaves reversible action
  untouched) and maps the negative space — attention selection, recovery, cost
  governance, skill effectiveness — where the same account/grade/calibrate method
  applies. Stays a candidate until proven across ≥2 distinct rings. Under the
  grammar `Account the unmeasurable; grade the claim; calibrate, don't assert.`

- [RFC: Accountable Tool-Schema Cost And The Deferred Definition-Side Compression Trigger](./rfc-accountable-tool-schema-cost-and-deferred-definition-compression.md):
  active RFC re-opening the 2026-03-02 deferral of definition-side capability
  compression (`maka`'s `load_tools` tool-schema economy). Phase 1 adds
  power-neutral tool-schema cost observability — a per-turn provider-visible
  schema token estimate plus a named `tool_schema_set_changed` accounted
  cache-break cause reusing `fingerprint`/`break-detector`/`context-evidence` —
  and a falsifiable gate read from that data. Phase 2 (gated) is a model-invoked
  `capability_expand` group activation with tape-receipt reseed and an
  execute-boundary guard, never a runtime auto-hide gate, keeping advertisement
  orthogonal to permission. Under the line `Measure schema cost before gating
it; if gated, the model operates it and the tape accounts for it`.

- [RFC: Completing Cron Recurrence In The Event-Sourced Scheduler](./rfc-scheduled-turn-source-and-control-plane-scheduler.md):
  active RFC (scope corrected after a disciplined read) completing — not replacing
  — the existing event-sourced scheduler fixed by the accepted
  `schedule-intent-hardening-and-control-plane-ergonomics` decision. The keystone
  is a correctness bug: `getNextCronRunAt` is TZ/DST-correct but has no caller, so
  both the projection and the daemon driver arm recurring cron intents at a
  `timestamp + 60_000` placeholder and never re-arm after a fire — a `0 9 * * *`
  intent does not recur. Wires one shared `nextRunAt` helper (cron + deterministic
  replay-stable jitter) into both read models, re-arms after fire, and extends the
  `MM HH * * *`-only parser to day-of-week so the shipped self-improve default
  `0 9 * * 1` parses. Lease/circuit-breaker/catch-up/convergence/projection
  persistence are confirmed config-only residue, deferred to a separate hardening
  note. Zero new surface — `Teach the scheduler the clock it already owns.`

- [RFC: Recall Next-Turn Cache Warming (Latency, Not Delivery)](./rfc-recall-next-turn-cache-warming.md):
  active RFC taking only the latency half of `hermes`'s memory prefetch and
  axiom-rejecting the injection half: a background `RecallBroker.warm()` that runs
  the existing dirty-flag `sync()` off the turn's critical path so the next
  explicit `recall_search` finds a warm broker and a warm local read model.
  Strictly index-local (no provider/embedding call, no network), single-flight with
  a racing live search, and result-neutral — it changes latency only, never what
  `recall_search` returns and never any model-visible byte. Lands below the
  visibility line as performance-only state under `Warm the cache, never the
context.`

- [RFC: Structured Provider-Failure Classification And Optional Backoff Retry](./rfc-provider-fallback-chain.md):
  active RFC (scope corrected after a disciplined read). The draft's gateway-owned
  fallback port, tagged taxonomy, ordered chain, first-frame lock, and per-attempt
  receipt all ALREADY EXIST — tested and backed by the accepted
  `preset-based-agent-model-routing` decision (`createHostedRuntimeProviderPort` with
  role-based `fallbackChains`, credential rotation, `classifyProviderFailure`, the
  `FrameWitness` compile-time lock, and `providerFallback` drift sampling). The real
  residue is two robustness edges of the existing classifier: read the HTTP status
  (carried on `ProviderStreamError.cause`) FIRST so a 402/odd-worded 429 stops
  misclassifying to `unknown` and missing credential rotation, with the message regex
  as fallback; and an optional, default-off same-model backoff retry for a transient
  `rate_limit` before downgrading. Zero new surface in phase 1. Under `The status code
is the most reliable signal a provider gives; classify from it first.`

When new unresolved design work starts, add one focused note here and link it
from this README. If the stable docs already carry the accepted contract, create
or update a decision/archive record instead of reopening this directory as a
secondary source of truth.
