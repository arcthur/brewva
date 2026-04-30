# Research: Skill Lifecycle Profile Subtraction

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-30`
- Promotion target:
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/tools.md`
  - `docs/architecture/cognitive-product-architecture.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted mental model is:

`A skill is one SKILL.md projected into discovery, selection, activation, and handoff slices. Hit rate belongs only to selection.`

The accepted decisions are:

- `Skill` is no longer treated as one wide object for every lifecycle decision.
- Runtime-owned profile builders compile narrow internal projections from the
  effective skill document.
- Cold-start hit rate may read only the selection projection.
- The selection projection is limited to `name`, `selection.when_to_use`,
  `selection.paths`, and authored `## Trigger` bullets.
- `selection.examples` and `selection.phases` are removed authored fields and
  fail closed.
- Handoff readiness is an actionability gate inside the selection shortlist; it
  does not add positive cold-start score or introduce candidates.
- `skill_load` renders the activation envelope instead of independently dumping
  the wide skill contract.
- External adapters, if added later, must not write into the selection
  projection or create hit-rate signals.

## Stable References

- `docs/reference/skills.md`
- `docs/reference/skill-routing.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/tools.md`
- `docs/architecture/cognitive-product-architecture.md`
- `packages/brewva-runtime/src/skills/profiles.ts`
- `packages/brewva-gateway/src/runtime-plugins/skill-first.ts`
- `packages/brewva-tools/src/skill-load.ts`

## Stable Contract Summary

1. Discovery answers who exists. It supports catalog and inspect surfaces, not
   hit-rate scoring.
2. Selection answers whether a skill should be chosen. It has separate
   `forScorer` and `forModel` views over the same approved source fields.
3. Activation answers what the model should see after explicit `skill_load`.
   It carries effect posture, budget summary, required outputs, required and
   missing inputs, bounded consumed outputs, relevant normalization issues, and
   effective instructions.
4. Handoff answers whether a shortlisted candidate is `blocked`, `available`,
   or `ready` now. It can require inputs or allow an actionable shortlisted
   candidate to proceed, but it cannot score cold-start selection.
5. The default hit-rate rule is code-owned: no field affects hit rate unless it
   belongs to the selection projection.
6. `## Trigger` is read from authored markdown only. Runtime-inherited guidance
   and effective markdown do not fall back into selection.
7. Full skill documents remain available behind explicit inspect and registry
   surfaces where callers need complete contract detail.

## Surface Budget Outcome

Accepted deltas:

| Surface                                                 | Before | After | Outcome                                         |
| ------------------------------------------------------- | -----: | ----: | ----------------------------------------------- |
| Required authored fields for minimal non-routable skill |      5 |     5 | No new authored requirements                    |
| Required authored fields for minimal routable skill     |      6 |     6 | No new authored requirements                    |
| Optional authored top-level field families              |     15 |    15 | No new authored metadata                        |
| Selection metadata child fields                         |      4 |     2 | `examples` and `phases` removed                 |
| Author-facing concepts                                  |      5 |     5 | Profiles are private implementation modules     |
| Inspect surfaces                                        |      1 |     1 | Existing inspect/index surfaces remain explicit |
| Routing/control-plane decision points                   |      3 |     3 | Mixed reads replaced by lifecycle projections   |
| Public tools                                            |      0 |     0 | `skill_load` behavior narrowed; no new tool     |
| Runtime object namespaces                               |      0 |     0 | No new durable lifecycle object family          |

No positive surface-budget delta is accepted by this promotion.

## Validation Status

Promotion is backed by:

- profile contract tests proving selection profiles expose only approved
  source fields
- property-style ledger tests proving non-selection fields cannot leak into the
  serialized selection profile
- routing eval fixtures covering TaskSpec bootstrap, cold-start routing, path
  routing, active continuation, blocked handoff gating, explicit skill names,
  and no-skill cases
- parser and authoring-validator tests proving removed selection fields fail
  closed
- `skill_load` contract tests proving default rendering uses the activation
  envelope rather than discovery or tool-hint dumps
- runtime-plugin tests proving handoff gates the shortlist without becoming a
  positive scoring signal

Representative anchors:

- `test/contract/runtime/skill-lifecycle-profiles.contract.test.ts`
- `test/contract/runtime-plugins/skill-routing-eval.contract.test.ts`
- `test/contract/runtime/skill-document-parsing.contract.test.ts`
- `test/contract/runtime/skills-discovery.contract.test.ts`
- `test/contract/tools/tools-skill-complete.contract.test.ts`
- `test/contract/runtime-plugins/runtime-plugin-tool-surface.contract.test.ts`

Final promotion verification used:

- `bun run check`
- `bun test`
- `bun run test:docs`
- `bun run test:dist`

## Historical Notes

- Earlier skill RFCs established `SKILL.md` authority, explicit activation,
  derived routability, and metadata-as-runtime-contract discipline. This
  promotion finishes the internal lifecycle Interface subtraction that those
  RFCs intentionally left open.
- `runtime.inspect.skills.list()` still exposes full skill documents as a
  general inspect surface. Hosted routing uses
  `runtime.inspect.skills.listForRouting()` instead, so hit-rate scoring crosses
  the runtime boundary through the narrow routing catalog.
- The active RFC intentionally avoided backward compatibility. Old
  `selection.examples` and `selection.phases` frontmatter now fails validation.
