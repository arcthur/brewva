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

- [RFC: Provider HTTP Transport (Forced HTTP/1.1, Idle Timeout, Proxy)](./rfc-provider-http-transport.md):
  active RFC borrowing pi-mono's `http-dispatcher` shape into brewva: a
  provider-scoped transport policy (forced HTTP/1.1 via `undici`
  `allowH2:false`, idle body/headers timeout, proxy) injected per OpenAI client
  to dodge the Feilian gateway's intermittent h2 RST. Consolidates the two
  scattered `new OpenAI({...})` sites; per client (not process-global) because
  bun's SDK bypasses the global undici dispatcher.

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
- [Candidate Axiom: Authorship Taints Verification](./candidate-axiom-authorship-taints-verification.md):
  candidate-axiom proposal distilling the essence of the now-accepted
  intent-realization loop — self-verification and independent review are
  different receipt kinds, so verification evidence must carry a `perspective`
  and an `independent` receipt a composed `independenceBasis[]`, with
  self-attestation impossible by construction (the authoring path has no
  perspective input). Proposes `Authorship taints verification` for
  `design-axioms.md` (extends axiom 11), maps the negative space (tool
  self-attestation, compaction fidelity, repository governance), and stays a
  candidate until proven across a second ring. The implementation landed as
  [Decision: Requirement Fitness And Independent Review](../decisions/requirement-fitness-and-independent-review.md).
- [RFC: Independence Debt — Surfacing The Authored-Review Blind Spot At Turn Close](./rfc-independence-debt-and-the-authored-review-blind-spot.md):
  active RFC incrementing delegation activation: when a must-have, high-risk-class
  atom reaches turn close with authored-only coverage and no independent read,
  surface that `independence debt` as advisory information so the model can
  discharge it (delegate a fresh-context reviewer, clear-context self-review, or
  add behavioral evidence). Diagnoses the game_4→game_5 delegation 3→0 swing — and
  the critical defects an authored-only close shipped — as a control-capability /
  missing-sensor gap (the evidence gap is recorded but never looped back to the
  decision point), not a weak signal; reuses graded evidence, drives no gate, and
  hands the choice to the model (axioms 1, 3, 7, 18). The information-channel
  companion to the authorship-taints-verification candidate axiom.
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

- [RFC: Programmatic Tool Calling — Declarative Tool Chains With Out-Of-Context Intermediate Results](./rfc-programmatic-tool-calling.md):
  active RFC, Phase 1 landed. A `tool_chain` managed tool runs a bounded,
  declarative sequence of read-only tools in one kernel transaction, dispatching
  each step's implementation directly (no per-step re-entrancy) and emitting
  per-step advisory `tool.result.recorded` receipts plus one
  `tool_chain.result.recorded` chain receipt, while only the selected step
  results enter context — intermediate results are tape-evident but
  context-absent. Promotion is blocked only on a measured context-economy
  signal.

- [RFC: Pre-Compaction Deterministic Prune — Dedupe, Informative Replace, And Image Strip Before LLM Summarization](./rfc-pre-compaction-deterministic-prune.md):
  active RFC, Phase 1 + Phase 2 landed. A pure `pruneCompactionInput`
  deterministically dedupes / informative-replaces / image-strips old tool
  results out of the LLM compaction summarizer's input only — never the tape and
  never the retained tail (the cut point re-derives `firstKeptEntryId` from
  entries). It emits a `session.pre_compact_prune` advisory telemetry receipt,
  joined to `session.compact` by `compactId` and durable plus replay-visible but
  never re-materialized into context (same treatment as `tool.result.recorded`).
  Gated by `compaction.pruneEnabled` (default true). Promotion is blocked only on
  real-session effectiveness measurement (Phase 3).

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

- [RFC: Model-Facing Runtime Intelligence Digests](./rfc-model-facing-runtime-intelligence-digests.md):
  active RFC generalizing the proven `[TurnConsequenceDigest]` pattern into a small
  bounded **runtime-brief** family that surfaces brewva's already-computed runtime
  intelligence (context pressure, compaction `netReuseValue` posture, tool-schema
  cost, open verifier findings) to the model — on the premise that a strong model
  is the best consumer of runtime intelligence brewva currently routes only to the
  operator. Strictly inform-only (read-only, authority-neutral, turn-tail so it
  never moves `stablePrefixHash`), revisiting the `cost-observability` "no context
  admission" boundary in form but honoring its intent. Core is a **legibility
  contract**: stable tagged structure, salience order, explicit units, no
  model-unusable hashes/ids, budgeted with structure-preserving drop, silent when
  nothing is decision-relevant. Under `Inform the model, don't seize it — and make
the telling legible.`

- [RFC: Capability Legibility, Retention Contract, And Recovery Recurrence](./rfc-capability-legibility-retention-contract-and-recovery-recurrence.md):
  active RFC distilling the residue from a four-quality experience audit of a
  peer hosted harness (`ika`) after most of its mechanisms prove
  already-covered or axiom-rejected: a bounded `selectable` capability
  sub-list plus a denial advisory that names the missing capability and its
  request path (visibility decoupled from authority; listing is never a
  receipt), an enforced compaction-survival contract for `attention_pin`
  workbench entries with accounted pinned mass and documented vocabulary, a
  relevance-gated `[RuntimeBrief]` failure-recurrence section derived from
  committed `err`/`aborted` receipts (evidence, not retry orchestration), a
  shadow-first generalization of the one existing static admission downgrade
  through the dormant `shadowToolAuthority` seam with numeric promotion
  gates, and two eval-gated prompt lines (goal holding, terse-instruction
  anchoring). Under the line `What the model cannot see it cannot choose;
what it pinned, physics keeps; what failed twice, the brief says so.`

When new unresolved design work starts, add one focused note here and link it
from this README. If the stable docs already carry the accepted contract, create
or update a decision/archive record instead of reopening this directory as a
secondary source of truth.
