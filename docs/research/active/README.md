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

## Machine-Decidable Promotion Gates

A promotion criterion that a machine can check declares its check as a gate
line nested under the criterion bullet:

```markdown
- The surface ceiling fitness landed and enforced.
  - gate: `bun test test/fitness/tool-surface-ceiling.fitness.test.ts`
```

Gates must be repo-runnable `bun test` / `bun run` commands;
`bun run analyze:promotion-readiness` lists them per note (`--run` executes),
and a docs fitness keeps every declared gate well-formed and its test paths
existing. Only mechanically checkable criteria get gates — prose criteria stay
prose, and promotion itself remains a reviewed human act; the readiness table
is a report, never a trigger.

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

- [RFC: Harness Candidate Integrity And Descriptive-Authority Subtraction](./rfc-harness-candidate-integrity-and-descriptive-authority-subtraction.md):
  active RFC from a verified external review of the improvement-loop
  subsystems. Six phases: demote token-overlap capability selections from
  authority to view (axiom 18) with full-manifest registry versioning and
  validated carry; delete the read-path hard gate keeping evidence-only
  recovery context; make `harness compare` refuse unmaterialized candidate
  manifests (`executedManifestId` honesty invariant); close the four broken
  attention-options feedback edges and delete `attention_verify_plan`;
  then materialize candidate deltas into trial-world-isolated replay and
  unify harness/eval/learnings under one candidate lifecycle with
  accountable accept/reject/archive verbs. Carries the optimization-surface
  boundary list (optimizable vs frozen) targeted at a decision record.

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
  decision point), not a weak signal; reads the fitness projection, drives no gate, and
  hands the choice to the model (axioms 1, 3, 7, 18). Its `independenceDebtAtoms` sensor
  survived the 2026-07-09 subtraction re-anchored grade-free (a high-risk must-atom with
  no deterministic/independent pass). The information-channel
  companion to the authorship-taints-verification candidate axiom. Landing-plan
  items 1–4 landed on `main` (`dbeeaf3`, `fbb0f00`), and Part 2 — the review→atom
  discharge edge — landed too (its RFC is superseded and archived as
  [rfc-review-atom-close-connection](../archive/rfc-review-atom-close-connection.md));
  what remains is empirical promotion.
- [RFC: Independence Trust Conditions After The Grade-Ceiling Subtraction](./rfc-independence-trust-conditions.md):
  active RFC completing the forward half of the 2026-07-09 harness subtraction: with the
  grade ceiling gone, an independent CLEAR genuinely discharges a high-risk atom, and the
  trust this places in the reviewer is mostly earned structurally (producer-keyed
  perspective, CLEAR-only + asked-set `atomRefs` via the coverage-scoped fold) — except
  ONE live asymmetry: findings age when the reviewed tree changes, passes never do, so a
  stale CLEAR still satisfies (a false-green path the ceiling used to mask). Proposes the
  mirror rule — STALENESS NEVER SATISFIES (same tape-only matcher, per-receipt own
  timestamp, over-aging errs safe by re-lighting debt) — and pins the four-bar
  reintroduction doctrine for the producerless `EvidenceItem` channel (domain-general +
  boundary-anchored, deterministic by construction, attribution declared never inferred,
  additive never a gate), so the next recurring defect becomes an eval fixture, not the
  next regex lens. Records the re-evaluation (independence, not determinism, was the owed
  property; capability compounds in the reviewer, not the regex) with game_7/8/9_1 as the
  eval evidence.
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

- [RFC: The `/worlds` Operator Panel — A git-like TUI Over The World/Rewind Substrate](./rfc-worlds-operator-panel.md):
  active RFC giving the shipped-but-invisible world substrate (content-addressed
  worlds, the world-restore rewind lane, basis-anchored delegation changesets) a
  first-class operator surface. Today's TUI renders only the conversation axis
  (`TreeOverlay`/`LineageOverlay`: turns, prompts, lineage); the environment axis — the
  world DAG, world↔world diffs, delegation-fork settlement, per-checkpoint world-lane
  readiness — is surfaced nowhere, and rewind hides behind a shortcut-less `/rewind`
  blocking picker. Proposes `/worlds` (+ `leader v`), an operate-tier overlay in the
  `jj op log`/`undo` mental model with three views (Timeline = conversation axis + world
  readiness chip; Diff = pure manifest world↔world / world↔working-tree diff with a
  redacted blob viewer; Forks = tape-rebuilt delegation settlement lanes) and a
  confirm-gated rewind (mode single-select), reusing the shipped
  `session.rewind/undo/redo` effects and `ConfirmDialogOverlay` wholesale — the only new
  code is three small pure pieces (`projectWorldDiff`, a read-only working-tree
  enumerate, a read-only `worlds` runtime-ops face) plus the standard overlay pipeline.
  Narrower invariants on the shared projection discipline: opening `/worlds` is strictly
  read-only (never capture/materialize/sweep), blob diffs render through the existing
  redaction layer (world blobs are raw bytes and may carry secrets), and it stays
  explicit-pull / never model-visible. Phased landing (1: read-only Timeline MVP; 2:
  Diff + confirmed rewind; 3: Forks lane). Under the line `A checkpoint already names a
world — the panel makes the world navigable, diffable, and reversible.`

- [RFC: Tool-Surface Subtraction And The Optimizer Last-Hop — What n=12 Real Sessions Say About Crystallized Heuristics](./rfc-tool-surface-subtraction.md):
  active RFC testing Lilian Weng's harness thesis against brewva's own tape: a
  strong model routes around crystallized heuristics and reaches for general
  primitives. Measures designed-vs-exercised model-facing surface across n=12 real
  sessions (7 read/analysis from the session index + 5 fresh build/comprehension
  runs on `glm5.2`, read from `tool.proposed`/`tool.committed` on the event tape):
  116 managed / 94–95 surfaced / **4** distinct tools used in the fresh corpus
  (`read`/`glob`/`edit`/`exec` — host-plane primitives), 12 across the read corpus,
  and **zero** across all twelve for `source_patch_*`, six of eight `code_*`,
  `verification_record`, the five `attention_*`, `recall`, `knowledge` (generic
  `read` beats `source_read` 82:6; the codebase-overview task drew a raw shell
  `find|grep|sort` over `code_digest`; `plan-map`/task-ledger also zero but they
  are `control_plane`, never model-surfaced). Concludes the specialized ontology is
  near-dead model-facing surface the model has already routed around, and proposes
  reversible measure-then-subtract: a per-family invocation view in the offline
  calibration recipe + a surface ceiling fitness, demotion now — by implementing
  the documented surface policy (base always; skill tools follow skill commitments;
  explicit request surfaces one turn), with receipt-bearing families gated on
  boundary-receipt equivalence — and deletion only after a cross-model
  re-measurement with a taught-ontology control arm (axioms 3, 15, 1, 7). Flags this dataset as the demand telemetry the planning-map /
  attention / capability-legibility RFCs deferred to (it reads near-zero), plus two
  incidental debt surfaces (`getEnvApiKey` zero callers; `skills.routing`/`overrides`
  removed with no migration shim, crashing existing configs at load) and the headless
  in-loop approval gap. Forward half (gated, note-only): make the sandbox+tape+fitness
  recipe an in-repo self-eval and parameterize the asserted attention constants, so
  the substrate brewva already shipped can close Weng's optimizer last-hop with the
  permission layer staying outside the loop. Under the line `A tool the model never
reaches for is a heuristic wearing a schema.`

- [RFC: The Optimizer Last-Hop — Unattended-Run Approval Provenance, In-Repo Self-Eval, And The Calibration Parameter Registry](./rfc-optimizer-last-hop-fuel-eval-and-parameter-registry.md):
  active RFC turning the tool-surface RFC's gated forward half into a landing
  plan, sequenced by what the 2026-07-11 alignment audit showed actually breaks
  the self-improvement loop: fuel (both `--print` backends suspend on the first
  `exec`, so unattended corpora cannot grow — Phase 1 generalizes the schedule
  lane's `origin: config_policy` provenance envelope into a config-declared,
  deny-first, fail-closed unattended approval policy, and becomes axiom 9's
  first precedent), a utility function (Phase 2 promotes the n=12 measurement
  recipe to a repeatable `report:self-eval` job whose fixtures join the D6
  freeze surface — an evaluator, never an optimizer), and a named action
  surface (Phase 3's calibration parameter registry declares which asserted
  constants are calibration-eligible with per-parameter evidence sources and
  `asserted`/`calibrated`/`contested` statuses — the EVOLVE-BLOCK fence for any
  future optimizer, while values still change only as reviewed code). Phase 4
  (proposal-lane backpressure) is demand-gated on a backlog counter. Claims the
  diversity-collapse residue, absorbs the audit's parameter-honesty debts
  (divergent recall freshness scales, the duplicate compaction threshold), and
  positions Phases 2 + 3 as the second-ring instance for the
  accounting-for-unmeasurable-benefit candidate axiom. Under the line `Feed it
under declared provenance, score it from the tape, and name exactly what it
may touch — the permission layer stays outside.`

- [RFC: Streaming Transcript Output Legibility — Dim The Tools, Fold The Code, Converge The Blocks](./rfc-streaming-transcript-output-legibility.md):
  active render-layer RFC fixing three co-occurring transcript complaints — code
  renders as one giant uncapped chunk, a normal interleaved turn stacks a dozen
  heavy blocks, and the descriptive prose drowns between them. Diagnoses each to
  the render layer (assistant code and whole-file writes/diffs are uncapped while
  tool output IS capped — the ceiling is inverted; the wire fold splits the
  assistant segment on every tool frame and each part carries a fixed `marginTop`;
  completed tools stay full-strength while borderless prose recedes) and borrows
  `opencode`'s organizing move — let tools recede (dim + single-line + packed) so
  narration advances — with **no new dependency** (the installed
  `@opentui/core@0.4.2` already ships the `CodeRenderable` / `createMarkdownCodeBlockRenderer`
  fold hooks). Three pillars, render-layer only (AS BUILT): (1) dim completed
  single-line tools + a pure `projectTranscriptRowHints` hint-map that packs
  consecutive same-turn inline tool rows to `marginTop=0` — a hint map, NOT grouped
  rows, so the transcript keeps its message-keyed `<For>` for zero per-frame rebuild;
  packing is guarded to a guaranteed-inline previous-tool allowlist; (2)
  information-density-first folding of long code and whole-file writes to 16 lines
  via `splitFoldableCodeBlocks` (TOP-LEVEL fences only, so list-nested fences are not
  torn out) + `collapseCodeContent` (line- AND width-capped, so a single 200KB line
  still folds), only at `stable`; **diff folding is deferred**; (3) per-turn label
  dedupe, plus reasoning collapsed to a title line (opencode borrow). Turn scope for
  packing/dedupe uses STRUCTURAL `turnId`/`attemptId` fields (never parsed from ids,
  which can embed channel `:tool:`/`:assistant:` sentinels); the `$PAGER` export
  renders with `folding: "static"` so nothing is stranded behind an inert hint.
  Surface Budget: two additive optional `CliShellTranscriptMessage` fields
  (`turnId`/`attemptId`); no config key, persisted format, or public surface; the
  wire-fold fold logic, the tape, and the transcript projector are untouched. The
  block-explosion **root** (per-tool-frame segment split) is deferred to a data-layer
  follow-up by design. Under the line `Let the tools recede so the narration advances
— and put a ceiling on every large payload.`

- [RFC: Seen-Lines Anchoring — Moving Edit Seen-Proof From The Wire Into Harness State](./rfc-seen-lines-anchoring.md):
  active RFC borrowing oh-my-pi's seen-lines edit model into brewva's anchor
  economy. Reframes honestly: brewva's per-line `L42@a1b2c3|` token already
  carries seen-proof (a 24-bit token is only emitted for displayed lines, so an
  unshown line cannot be cited) — this is **not** a missing-security story. It is
  priced as an O(lines) wire tax paid twice: `~9 + digits` bytes of prefix on every
  read line (~4.8 KB at the 400-line cap) plus the full anchor string re-echoed on
  every `source_patch_prepare` intent. oh-my-pi does the same two jobs — seen-proof
  and drift detection — at O(1): one whole-file content tag in the read header, a
  harness-side `seenLines` set, and plain `NN:` line numbers, with a reveal-on-reject
  self-heal the per-line token cannot offer (a seen-miss reveals the unseen line and,
  on a **complete** full-width reveal, merges it so a straight retry lands without a
  re-read; a truncated reveal merges nothing, blocking piecewise circumvention).
  Chosen path: **clean cutover** — replace the per-line token outright with `NN:`
  line numbers + a harness `seenLines` set + reveal-on-reject, no transitional flag
  and no format coexistence (the value is already decided; a permanent dual-format
  toggle is exactly the backward-compat cruft brewva rejects). Two corrections the
  code forced, recorded for honesty: (1) brewva keeps its **surgical per-line-text
  drift and recovery** unchanged — the earlier draft's whole-file tag + 3-way merge
  was omp machinery that buys no token economy (drift is harness-side either way) and
  only imports omp's whole-file strictness; recovery stays unique-`text` relocation
  (what the cached `hash` already encoded, so `hash` is dropped as redundant). (2) No
  `anchorFormat` discriminator and no config key — with no coexistence there is
  nothing to discriminate; old pre-cutover snapshots simply fail the rehydration guard
  (missing `seenLines`) and self-heal via re-read. Preserves brewva's skeleton wholesale
  (prepare never mutates, apply is the single write gate with a whole-file `before`-compare
  preflight, rollback artifact, tape snapshots, `source_patch_stale_recovered`). Surface:
  replaces a model-facing wire 1:1 and the durable snapshot event gets **lighter** net
  (`seenLines` added, per-anchor `token` + 64-hex `hash` removed); rides the existing
  non-canonical snapshot event (no new literal), zero authored surface. The three
  contract/property tests that pin today's format are rewritten (their invariants survive;
  the surface changes), and the real promotion gate is a git-revision A/B token/success delta,
  not a static assertion. Under the line `The per-line token pays wire tokens to avoid holding
state; keep the state, drop the token — safety equivalent, economy better, and a reject can
finally reveal.`

- [RFC: Skill Discipline Calibration — Hard Safety Gates, Soft Cognitive Defaults, And Rules That Earn Their Keep](./rfc-skill-discipline-calibration.md):
  active RFC recalibrating the built-in skill corpus's wording authority after
  a full-corpus audit, two cross-checked corpus reviews, and two absorbed
  reviews of its own first draft: the corpus writes safety invariants and
  depreciating cognitive-deficit patches in the same absolute register, and —
  SkillCards being advisory — the wording IS the governance, rebuilding at the
  skill layer the thought-path prescription axiom 4 forbids at the kernel
  layer. Ten verified findings: a self-sealing letter-compliance meta-clause,
  mixed-tier Iron Laws, self-report scripts claiming authority beyond the
  advisory-lint ceiling, count budgets where evidence conditions belong,
  posture formulas with downstream cascade, phase-identity constraints beyond
  permission truth, mandated fanout/dissent topology, a live
  `promote.sh → AGENTS.md` unreviewed-write primitive contradicting the
  accepted calibration standard (plus self-improve's own Iron Law and
  calibration-report's human-review claim), adoption measuring `opened` not
  `followed` (a Goodhart feed into calibration), and no reality-arbitration
  rule or retirement loop. The absorbed review round rebuilt the proposal:
  kernel/scaffold anatomy (strict material relocated into lazy-loaded
  scaffolds, never deleted), a minimal rule manifest (`ruleId` + three tiers
  `non-negotiable`/`controlled-exception`/`adaptive-heuristic` + exception
  evidence class) as the precondition for any softening, a 2–3 skill pilot
  instead of a corpus rewrite, a three-arm paired eval (no-skill /
  kernel-only / kernel+scaffold) gated on oracle task-success
  non-inferiority across strong and weak tiers, two-lane reality arbitration
  (descriptive yields to evidence; normative escalates), retirement requiring
  an eligible-opportunity denominator, and per-model profiles deferred to
  their own RFC. Phase 0 stays deterministic: promotion → RDP-style reviewed
  candidates; adoption renamed `opened`. The verification ladder, honesty
  contracts, side-effect gates, and project invariants are named appreciating
  assets, out of subtraction scope. Under the line `Govern effects, not
thought paths — in the skill text too; an exception carries evidence, not
eloquence.`

When new unresolved design work starts, add one focused note here and link it
from this README. If the stable docs already carry the accepted contract, create
or update a decision/archive record instead of reopening this directory as a
secondary source of truth.
