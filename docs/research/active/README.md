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
  bun's SDK bypasses the global undici dispatcher. Landed on `main` (`ca2c984`,
  8 unit tests green); only the live feilian-window dogfood remains before promotion.

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
  companion to the authorship-taints-verification candidate axiom. Landing-plan
  items 1–4 landed on `main` (`dbeeaf3`, `fbb0f00`), and Part 2 — the review→atom
  discharge edge — landed too (see the next entry); what remains is empirical promotion.
- [RFC: Review→Atom Attribution And The Grade Ceiling On Discharging Independence Debt](./rfc-review-atom-close-connection.md):
  active RFC on the independence-debt close edges (Part 2), reshaped after an independent
  code review caught the author's own blind spot. game_7's independent review (6 findings,
  4 fixes incl. the recurring `req-1` keycode defect) still left `open: 2` for TWO reasons:
  the review was a `files` review whose findings carried empty `atomRefs` (attribution
  gap), AND — the deeper one — a presence-grade LLM review architecturally CANNOT drive a
  high-risk atom to `satisfied` (Part 1's grade floor: independent outcomes are
  presence-grade; only `static_guard`+ deterministic evidence clears high risk). Honest
  thesis: coverage-scope the fold (target files ⊇ fresh-touched universe via
  `universeCoveredBy`, NOT target kind — game_7 was a files-covering-all review) so a FAIL
  marks the violated atom (`open` drops for genuinely-broken atoms; the model gets
  atom-anchored findings); a CLEAR reaches only `likelySatisfied` and is NOT claimed as a
  discharge; at-grade clearing is the static-guard producer's job (6 lenses only); and
  unguarded high-risk debt (req-8/req-11) is irreducible headlessly — the sensor stays
  correctly lit (axiom 7). One actuator per close-edge.
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
reference must prove it still resolves`. All five loops landed v1 on `main`
  (`0485dc7` + the Loop 1 receipt closure); only Loop 3's happy-path summary swap
  (benchmark-gated) and Loop 4's per-model target stay deferred.

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
context.` Both phases landed on `main` (`9f583ae`); the remaining promotion gate
  is the cold-vs-warm latency measurement, not the mechanism.

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

- [RFC: Durable Cross-Session Planning Map — The Third Leg Beside Lossy Continuation And Single Persistent Intent](./rfc-durable-cross-session-planning-map.md):
  active RFC (Phase 1 + 2 landed and green; not yet promoted — Phase 3 demand
  telemetry pending) positioning a durable, externalized, decomposed planning
  map as the third answer to "the work does not fit in one context," beside
  compaction (leg 1, lossy in-band continuation of the retained tail) and the
  `goal` control plane (leg 2, one lossless-but-singular persistent intent). For
  work that is both **larger than one context window** and still in **fog** — where
  the destination is knowable but the route is not — the map holds a frontier of
  open decisions as tape receipts a `plan.map.state.get` projection rebuilds, so a
  resuming session loads a low-res page plus one claimed ticket instead of a
  compacted transcript. Adapts the external `wayfinder` methodology (tickets, one
  per session, fog-of-war graduation) but replaces its issue tracker with brewva's
  own substrate (the `goal.*` tape-folded-projection pattern, the steering-inbox
  durable sidecar, the session-index read model). Strictly planning, not execution:
  resolving a ticket is a receipt that derives no authority (axiom 18), the map is
  explicit-pull and never auto-injected (axiom 1), concurrent sessions coordinate
  optimistically through append-only receipts and a claim primitive rather than a
  saga (axiom 17), and the frontier is a projection, never a runtime planner (axiom
  12). Gated on measured cross-session demand — the MVP may be a durable markdown
  map, with the projection + concurrency machinery earning its weight only if real
  efforts contend across sessions. Under the line `Compaction keeps the tail; the
goal holds the intent; the map externalizes the plan.`
- [RFC: Coupled World Rewind, Delegation Changeset Physics, Reversibility Tiers, And The Supervision Surface](./rfc-coupled-world-rewind-delegation-changesets-and-reversibility-tiers.md):
  active RFC distilling the residue of the Shepherd substrate study (arXiv
  2605.10913 + repo, evaluated 2026-07-08) after the honest comparative finding
  — Brewva's tape tree is stronger on the conversation axis (Shepherd has no
  durable mid-run fork), Shepherd is stronger on the environment axis — and
  after rejecting Shepherd itself as a dependency (Python-only, no wire
  protocol, batch task model, three in-flight kernels). Four loops: a durable
  **world snapshot** per mutating `checkpoint.committed` in a private git-object
  store with a world-restore lane in the rewind transaction engine (covers
  `exec`-written files for the first time; missing rollback artifacts degrade
  instead of failing the window), **changeset physics** for the declared-but-
  hollow `patch-snapshot` delegation archetype (clonefile/copy carrier fork →
  seal `PatchSet` → ff/path-disjoint fail-closed settlement onto the existing
  adoption dispositions), derived **reversibility tiers** projected into
  approval and rewind preview (views only — a fitness pins that no authority
  path reads them), and a gated opt-in **supervision surface** mapping
  Shepherd's inject/handoff/discard onto steering-inbox append, tape-leaf fork,
  and coupled rewind. Under the line `A checkpoint names a world, not just a
conversation; a delegated edit lands only when adopted; every effect knows its
way back — or says it has none.`

When new unresolved design work starts, add one focused note here and link it
from this README. If the stable docs already carry the accepted contract, create
or update a decision/archive record instead of reopening this directory as a
secondary source of truth.
