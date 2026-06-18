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
- [RFC: Context Operating System And Compaction Physics](./rfc-context-operating-system-and-compaction-physics.md):
  active RFC for closing Brewva's context-budget loop, making compaction cut
  points token-aware, and promoting workbench-gated compaction into a runtime
  contract.
- [RFC: TUI Rendering Performance And Test Harness](./rfc-tui-rendering-performance-and-test-harness.md):
  active RFC for removing per-frame full view-model cloning, O(n) per-token
  projector work, the scroll-sync feedback loop, stale composer write-back,
  and synchronous keystroke-path filesystem I/O from the interactive shell,
  moving toward a dual-speed state channel and gated on a deterministic
  replay benchmark and count-based fitness invariants.
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

When new unresolved design work starts, add one focused note here and link it
from this README. If the stable docs already carry the accepted contract, create
or update a decision/archive record instead of reopening this directory as a
secondary source of truth.
