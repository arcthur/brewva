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

## Runtime Fidelity

- [`event-stream-consistency-and-replay-fidelity.md`](./event-stream-consistency-and-replay-fidelity.md)
- [`recovery-robustness-under-interrupt-conditions.md`](./recovery-robustness-under-interrupt-conditions.md)
- [`model-operated-working-memory-evaluation.md`](./model-operated-working-memory-evaluation.md)
- [`prefix-stable-context-management-and-progressive-compaction.md`](./prefix-stable-context-management-and-progressive-compaction.md)
- [`recovery-first-context-governance-and-history-view-baselines.md`](./recovery-first-context-governance-and-history-view-baselines.md)

## Operator And Control Surfaces

- [`cost-observability-and-budget-governance.md`](./cost-observability-and-budget-governance.md)
- [`rollback-ergonomics-and-patch-lifecycle-safety.md`](./rollback-ergonomics-and-patch-lifecycle-safety.md)
- [`convention-projectors-and-substrate-review.md`](./convention-projectors-and-substrate-review.md)
- [`context-control-plane-simplification.md`](./context-control-plane-simplification.md)

## Model-Operated Product Ergonomics

- [`model-operated-context-skills-and-memory-ergonomics.md`](./model-operated-context-skills-and-memory-ergonomics.md)

## Tooling And Source Intelligence

- [`multi-language-source-intelligence.md`](./multi-language-source-intelligence.md)

## Execution Substrate

- [`provider-transport-ownership-and-substrate-driver-boundary.md`](./provider-transport-ownership-and-substrate-driver-boundary.md)
