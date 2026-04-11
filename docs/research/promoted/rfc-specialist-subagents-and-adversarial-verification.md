# Research: Specialist Subagents And Adversarial Verification

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-04-02`
- Promotion target:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/tools.md`
  - `docs/reference/skills.md`
  - `docs/guide/features.md`
  - `docs/guide/orchestration.md`
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/journeys/operator/interactive-session.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`

## Promotion Summary

This note is now a short status pointer.

The specialist subagent reset has been promoted into stable architecture,
reference, and operator docs.

Stable implementation now includes:

- the public delegated specialist surface is `advisor`, `qa`, and
  `patch-worker`
- public `general` and delegated public `verification` were removed from new
  public requests
- delegated `resultMode = "qa"` replaces the old delegated
  `resultMode = "verification"` for new requests
- `runtime.verification.*` remains kernel authority over evidence sufficiency
  and freshness; it is not a delegated specialist
- delegated QA persists canonical `QaSubagentOutcomeData` and mirrors it into
  `skillOutputs.qa_*`
- `qa-runner` is effectful but non-patch-producing through
  `producesPatches: false`
- envelope tool surfaces are hard ceilings; skill and packet hints cannot widen
  them
- built-in specialists now use authored constitutions instead of relying only
  on thin preambles
- read-only specialists gained dedicated repository observation tools:
  `git_status`, `git_diff`, and `git_log`
- public semantic skills route into explicit consult posture instead of
  expanding the public worker taxonomy:
  `discovery -> advisor (investigate)`, `debugging -> advisor (diagnose)`,
  `design -> advisor (design)`, and `review -> advisor (review)`
- `consult` is the first-class read-only delegated result posture, keyed by
  explicit `consultKind`, rather than a second public `explore` / `plan` /
  `review` worker surface
- parent-owned `design` now emits the full planning handoff set:
  `design_spec`, `execution_plan`, `execution_mode_hint`, `risk_register`, and
  `implementation_targets`; delegated `design` consults inform this artifact
  lane without becoming a separate public planning worker contract
- canonical QA semantics preserve `pass`, `fail`, and `inconclusive`, and a
  `pass` requires executable evidence, at least one adversarial probe, and
  coverage of plan-declared `required_evidence`
- delegated outcome contracts are canonical-only: `consult`, `qa`, and `patch`

Stable references:

- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/tools.md`
- `docs/reference/skills.md`
- `docs/guide/features.md`
- `docs/guide/orchestration.md`
- `docs/journeys/operator/background-and-parallelism.md`
- `docs/journeys/operator/interactive-session.md`
- `docs/journeys/operator/inspect-replay-and-recovery.md`

## Stable Contract Summary

The promoted contract is:

1. Brewva keeps a small public delegated specialist surface and does not retain
   `general` as a public escape hatch. The stable built-in worker presets are
   `advisor`, `qa`, and `patch-worker`.
2. Delegated executable QA and `runtime.verification.*` are separate concepts:
   QA tries to break the change; the runtime decides whether evidence is
   sufficient and fresh.
3. Only `patch-worker` is patch-producing. `qa-runner` is effectful for
   execution and evidence capture, but it does not enter `WorkerResult`
   merge/apply semantics.
4. Delegated QA evidence is first-class outcome data, not merely mirrored skill
   output.
5. Envelope-declared tool surfaces are hard ceilings, and context narrowing is
   explicit through `contextProfile`.
6. Internal review lanes remain internal fan-out behind the public semantic
   `review` boundary; they are not part of the public worker taxonomy.
7. `consult` is the canonical read-only delegated posture, and `consultKind`
   differentiates `investigate`, `diagnose`, `design`, and `review` without
   widening the public specialist surface.
8. Delegated outcome kinds are canonical-only: `consult`, `qa`, and `patch`.
   Runtime verification remains a separate kernel authority rather than a
   delegated specialist result kind.

## Validation Status

Promotion is backed by:

- contract and routing coverage for the stable delegated public surface
- QA semantic validation and normalization coverage
- workflow derivation coverage for canonical QA outcome data
- contract and workflow coverage for parent-owned planning artifacts informed
  by delegated `design` consult outcomes
- replay/inspect coverage for historical delegated `verification` records
- docs coverage across architecture, reference, and operator journeys
- repository verification:
  - `bun run check`
  - `bun test`
  - `bun run test:docs`
  - `bun run format:docs:check`

## Remaining Backlog

The following questions are intentionally outside the promoted contract:

- whether built-in specialist constitutions should eventually move from
  TypeScript-authored constants into standalone authored artifacts
- whether `qa_checks[*].observedOutput` should stay inline by default or move
  toward bounded excerpts plus artifact references
- whether evidence-audit should eventually surface through a dedicated internal
  artifact in addition to `review-operability`
- when and how historical delegated `verification` records should be fully
  migrated or retired
- whether any currently explicit-only delegated skills should later gain their
  own stable public specialist mapping

If those areas become product priorities, they should start from a new focused
RFC rather than reopening this note as a mixed design-and-status document.

## Historical Notes

- Historical problem framing, option analysis, and phased cutover planning were
  removed from this file after promotion.
- The stable contract now lives in architecture, reference, journey docs, and
  regression tests rather than in `docs/research/`.
