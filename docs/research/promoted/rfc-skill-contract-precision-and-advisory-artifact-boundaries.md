# Research: Skill Contract Precision And Advisory Artifact Boundaries

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-17`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/runtime-plugins.md`

## Promotion Summary

This note is now a short status pointer.

Brewva no longer treats semantic-bound skill outputs as producer-side exact
canonical objects by default. Raw `skill_completed` payloads remain the durable
producer truth, while runtime-owned normalized views carry canonical
consumer-facing structure, field-level issues, blocking metadata, and
provenance.

Stable implementation now includes:

- raw producer outputs preserved as durable `skill_completed` evidence
- `runtime.inspect.skills.getRawOutputs(...)`,
  `getNormalizedOutputs(...)`, and `getConsumedOutputs(...)`
- consumer-driven blocking through Tier A/B/C normalization issues and named
  `blockingConsumer` metadata
- `workflow_status` and `skill_load` surfaces that distinguish raw presence,
  normalized availability, partial state, and blocking consumers
- repair and completion-guard guidance that surfaces minimum acceptable
  contract state instead of assuming canonical full-schema retry for advisory
  drift

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/reference/skills.md`
- `docs/reference/skill-routing.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/reference/runtime-plugins.md`

## Stable Contract Summary

The promoted contract is:

1. Semantic schema ids such as `planning.execution_plan.v2` name normalized
   consumer-facing views, not exact producer payload shapes.
2. Producer completion validates required output presence, authored
   non-semantic `output_contracts`, and Tier A blockers at the boundary where a
   safe decision is made.
3. Tier B fields may remain partial after producer completion, but a named
   downstream consumer may block until normalization resolves the required
   fields.
4. Tier C fields remain advisory metadata. They may normalize into warnings,
   degraded summaries, or `unknown` canonical values, but they do not block
   producer completion or workflow progression.
5. Completion guard and repair posture surface unresolved Tier A/B fields, the
   next blocking consumer, and the minimum contract needed to proceed safely
   instead of teaching full-schema retry as the only recovery path.

## Validation Status

Promotion is backed by:

- runtime contract coverage for normalized output inspection surfaces
- contract and unit coverage proving semantic bindings stay consumer-facing
  while producer validation remains narrow
- workflow derivation coverage showing partial normalized planning state is
  inspectable without collapsing to "missing plan"
- tool contract coverage showing advisory planning taxonomy drift is accepted
  and surfaced as normalization issues rather than producer rejection

Representative anchors:

- `test/contract/tools/tools-skill-complete.contract.test.ts`
- `test/unit/runtime/skill-validation-pipeline.unit.test.ts`
- `packages/brewva-runtime/src/workflow/artifact-derivation.ts`
- `packages/brewva-gateway/src/runtime-plugins/completion-guard.ts`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- broader field-level instrumentation to decide future Tier B to Tier C pruning
- whether normalized projections should always rebuild on demand or may persist
  as cache-like derived state when operational evidence justifies it
- broader provenance-default and fuzzy-alias policies beyond the current narrow
  whitelist for non-blocking taxonomy fields

If those areas need stronger guarantees later, they should start from a new
focused RFC rather than reopening this note as a mixed design-and-status
document.

## Historical Notes

- The active RFC carried detailed design options, migration sequencing, and
  open questions while implementation was in flight; those details were removed
  after stable docs absorbed the contract.
- `docs/reference/context-composer.md` is not a stable contract target for
  artifact precision. It presents already-admitted context rather than defining
  semantic-output blocking rules.
