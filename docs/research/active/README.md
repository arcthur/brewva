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

When new unresolved design work starts, add one focused note here and link it
from this README. If the stable docs already carry the accepted contract, create
or update a decision/archive record instead of reopening this directory as a
secondary source of truth.
