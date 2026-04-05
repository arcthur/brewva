# Research: Advisor Consultation Primitive And Specialist Taxonomy Cutover

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-04-05`
- Promotion target:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/tools.md`
  - `docs/reference/skills.md`
  - `docs/guide/orchestration.md`
  - `docs/journeys/operator/background-and-parallelism.md`

## Direct Conclusion

This RFC has been implemented.
It is now best read as a rationale record and promotion pointer rather than an
open proposal.

The resolved model is:

- public delegated agent specs are `advisor`, `qa`, and `patch-worker`
- public delegated result modes are `consult`, `qa`, and `patch`
- `advisor` is the single public read-only consultation identity
- `AdvisorConsultKind` is required for `consult` runs:
  `investigate`, `diagnose`, `design`, and `review`
- `AdvisorConsultBrief` is required for `advisor` consultation requests
- `skillName` no longer implicitly selects `consultKind`
- semantic workflow posture remains parent-owned and keyed to
  `workflow.design`, `workflow.execution_plan`, `workflow.review`,
  `workflow.qa`, and related semantic lanes
- internal review lanes remain explicit parent-orchestrated
  `consult/review` delegates under the advisor envelope family
- immutable historical delegation records are not rewritten; replay uses
  read-time versioned normalization instead of tape mutation

The legacy public read-only specialist surface `explore`, `plan`, and `review`
was not retained.
The final implementation chose a hard stable cutover for new writes, routing,
and stable docs rather than long-lived public aliases.

## Stable Contract Summary

The first-principles architectural line is:

`advisor` unifies read-only delegated execution identity; parent-owned
semantic skills still define what the work means and what workflow progress
exists

Current-state clarification:

- `advisor` is an execution identity, not a semantic workflow stage
- `consult` outcomes are advisory and typed; they do not complete semantic
  skills on behalf of the parent
- `diagnose` is a first-class consultation contract for debugging and root
  cause analysis
- `qa` and `patch-worker` remain distinct because their effect posture and
  adoption semantics differ from consultation work
- the former `BrewvaSemanticOracle` surface was renamed to
  `BrewvaSemanticReranker` to avoid role collision with delegated consultation

## Stable Docs Owning The Result

The current stable contract now lives in:

- `docs/reference/tools.md`
  - public delegation packet schema, `consultBrief`, `consultKind`, and
    stable agent specs
- `docs/reference/skills.md`
  - semantic-skill routing into `advisor` consultation kinds
- `docs/guide/orchestration.md`
  - execution envelopes, public specialist surface, and parent/child split
- `docs/journeys/operator/background-and-parallelism.md`
  - operator-facing detached-run semantics for `advisor`, `qa`, and
    `patch-worker`
- `docs/architecture/cognitive-product-architecture.md`
  - workflow posture boundary and explicit separation between advisory helpers
    and semantic workflow progress

## What Was Fixed

This cutover resolved four structural problems.

1. Public read-only delegated execution identity was fragmented even though the
   actual execution posture was nearly identical.
2. Debugging lacked a first-class delegated diagnostic contract.
3. Review fan-out needed to stay explicit and parallel without pretending a
   single read-only child owned nested delegation.
4. Oracle terminology was overloaded across delegated consultation and semantic
   reranking.

## Migration And Replay Posture

The implementation intentionally took a hard stable contract approach for new
writes and stable public docs.

- workspace overlays, catalog defaults, stable docs, and stable routing moved
  directly to `advisor`, `consult`, and `AdvisorConsultKind`
- new runtime writes no longer emit the former public `exploration`, `plan`,
  or `review` outcome kinds
- immutable history remains replayable through read-time versioned
  normalization
- read-time normalization exists for replay correctness, not as a continued
  stable public compatibility layer

## Validation Signals

The cutover is considered implemented because:

- the delegation contract requires explicit `consultKind` and `consultBrief`
  for `advisor` consultation
- `skillName` no longer acts as an implicit consult selector
- stable public docs describe only `advisor`, `qa`, and `patch-worker`
- internal review lanes run as explicit `consult/review` delegates
- verification covered type checks, unit and integration tests, doc tests, and
  distribution checks:
  - `bun run check`
  - `bun test`
  - `bun run test:docs`
  - `bun run format:docs:check`
  - `bun run test:dist`

## Historical Note

Earlier revisions of this document described the full proposal, migration
arguments, and cutover rationale in more detail.
Those sections have been condensed now that the design is implemented.
Current delegation truth should be read from the stable docs listed above.
