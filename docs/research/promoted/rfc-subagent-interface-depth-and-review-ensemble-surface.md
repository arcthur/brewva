# Research: Subagent Interface Depth And Review Ensemble Surface

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-30`
- Promotion target:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/tools.md`
  - `docs/reference/skills.md`
  - `docs/guide/orchestration.md`
  - `docs/journeys/operator/background-and-parallelism.md`

## Promotion Summary

This note is now a short status pointer.

The subagent public-surface narrowing and delegation primitive reset has been
promoted into stable architecture, reference, guide, and operator docs.

Stable implementation now includes:

- public delegated authoring goes through `subagent_run` and `subagent_fanout`
  with `skillName` plus task packet fields
- ordinary public callers no longer pass `agentSpec`, `envelope`,
  `consultKind`, `fallbackResultMode`, `executionShape`, `mode`,
  `activeSkillName`, or `consultBrief`
- `subagent_run_diagnostic` is the maintainer control-plane surface for
  explicit low-level routing probes
- public `subagent_run` and `subagent_fanout` hard-fail removed low-level
  fields instead of silently accepting legacy shape
- `subagent_fork` is a delegation execution primitive, not a catalog
  specialist
- built-in public specialists remain `advisor`, `qa`, and `patch-worker`
- internal `review-*` lanes stay behind the review ensemble and do not appear
  in the public specialist taxonomy
- hosted agent specs carry `visibility`, and execution envelopes carry
  `isolationStrategy`
- `readonly-advisor=shared`, `qa-runner=ephemeral`, and
  `patch-worker=snapshot`
- custom specialists live under `.brewva/subagents/*.md` or
  `~/.brewva/subagents/*.md`, must extend one of the three public specialists,
  and may only narrow the base surface
- workspace execution envelope config and JSON subagent config files are no
  longer accepted
- delegation records require `contractVersion`, `executionPrimitive`,
  `visibility`, `isolationStrategy`, and `adoption`
- missing or unknown delegation contract versions fail closed rather than being
  normalized implicitly
- public status and cancellation details project away low-level routing fields;
  `subagent_status(detailMode=internal|diagnostic)` is the explicit drill-down
  path

Stable references:

- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/tools.md`
- `docs/reference/skills.md`
- `docs/guide/orchestration.md`
- `docs/journeys/operator/background-and-parallelism.md`

## Stable Contract Summary

The promoted contract is:

1. The public delegated specialist surface is stable and authority-shaped:
   `advisor`, `qa`, and `patch-worker`.
2. Public delegation is intent-first. Normal callers provide `skillName` and
   packet fields; the resolver derives agent spec, envelope, result kind,
   consult kind, context profile, visibility, model route, and adoption
   contract.
3. Diagnostic delegation is physically separate. Maintainer-only
   `subagent_run_diagnostic` may specify low-level target and routing fields,
   but that path is not ordinary operator guidance.
4. Review lanes are internal implementation detail behind the review ensemble.
   Lane identities may appear in internal or diagnostic inspection, but they do
   not widen the public specialist list.
5. `plan` remains a parent-owned workflow. Delegated advisor design consults
   can inform planning artifacts, but the child does not own plan completion or
   patch adoption.
6. `subagent_fork` records same-parent-lineage execution with
   `executionPrimitive=fork`; it does not enter the hosted agent catalog and
   cannot expand authority beyond the parent ceiling.
7. Hosted envelopes own hard tool ceilings and explicit isolation strategy.
   Skill metadata, packets, and custom specialists may narrow but cannot widen
   envelope authority, tool sets, context profile, patch production, or
   isolation.
8. Custom specialists are extension by narrowing, not taxonomy growth. They
   must extend `advisor`, `qa`, or `patch-worker`, and invalid frontmatter is a
   hard error.
9. Delegation run records are versioned and fail closed on missing or unknown
   versions. The current contract intentionally does not support implicit
   legacy normalization.
10. Parent adoption is explicit through delegation adoption records. QA,
    review, and patch outcomes map to `allow`, `block`, or `require_human`
    decisions with required evidence.
11. Public status defaults are projected. Internal lane records and diagnostic
    routing fields require explicit detail mode.
12. Capability growth should land in primitives, envelopes, resolver policy,
    memory, hooks, and inspection views before adding public specialist names.

## Surface Budget Outcome

This was a surface-affecting promotion. Runtime and gateway maintainers should
review this budget against code and stable docs when the promoted pointer is
refreshed.

| Surface                               | Before | After | Outcome                                                                                                                                                                        |
| ------------------------------------- | -----: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Required authored fields              |      2 |     2 | Public delegation still requires intent plus objective/tasks. Custom specialist authoring requires `extends` while inheriting name/defaults from the file and base specialist. |
| Optional authored fields              |     22 |    14 | Public delegation removed eight low-level or legacy fields from ordinary authoring.                                                                                            |
| Author-facing concepts                |     15 |     7 | The public model collapses to three specialists, fork, diagnostic delegation, visibility detail mode, and custom specialist narrowing.                                         |
| Inspect surfaces                      |      2 |     2 | Existing delegation status/inspection remains, but defaults are projected and detail modes gate internal or diagnostic fields.                                                 |
| Routing/control-plane decision points |      8 |     4 | Public callers keep skill intent, effect ceiling, wait mode, and return mode; low-level target/model/lane choices move to resolver or diagnostic tooling.                      |

The net budget is non-positive for required fields, author-facing concepts, and
routing/control-plane decision points. Optional fields also shrink on the
ordinary public delegation path.

## Validation Status

Promotion is backed by:

- public-surface snapshot coverage for `subagent_run` and `subagent_fanout`
- contract coverage that public tools reject diagnostic fields
- contract coverage that public result details do not leak low-level routing
  fields
- diagnostic-tool coverage proving explicit low-level fields remain available
  to maintainer workflows
- gateway catalog tests for public/internal visibility, isolation strategy, and
  custom specialist narrowing
- delegation-store tests for required contract version and fail-closed unknown
  versions
- delegation adoption contract tests for QA, review, and patch outcomes
- review ensemble tests for deterministic lane activation and synthesis
- stable docs coverage across reference, guide, and operator journeys
- repository verification:
  - `bun run check`
  - `bun test`
  - `bun run test:docs`
  - `bun run format:docs:check`
  - `bun run test:dist`

## Remaining Backlog

The following work is intentionally outside the promoted contract:

- per-specialist persistent memory buckets for `advisor`, `qa`, and
  `patch-worker`
- delegation lifecycle hooks such as `onDelegationStart`, `onCompletion`, and
  `onAdoption`
- a richer live mission-control view that shares the replay inspect plane
- first-class persistence for rejected and deduplicated review findings beyond
  the current review disclosure paths
- additional isolation strategies such as worktree or container-backed
  execution when their runtime support is ready
- runtime-enforced parent plan posture beyond the current parent-owned
  workflow contract and read-only planning semantics
- historical contract normalizers if a future migration chooses compatibility
  over the current fail-closed version policy

Future work in those areas should start from focused RFCs or implementation
slices rather than reopening this pointer as a mixed roadmap.

## Historical Notes

- The original active note compared Kimi CLI, Claude Code, and Codex public
  subagent role shapes. The promoted contract keeps the accepted lesson:
  public role names should describe execution authority, while specialization
  belongs in resolver policy, envelopes, internal lanes, and result contracts.
- Long-form migration planning and temporary open questions were removed after
  promotion. The stable contract now lives in architecture, reference, guide,
  journey docs, and regression tests.
