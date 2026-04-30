# Decision: Specialist Subagents And Adversarial Verification

## Metadata

- Decision: Brewva keeps a small public delegated specialist surface and does not retain `general` as a public escape hatch. The stable built-in worker presets are `advisor`, `qa`, and `patch-worker`.
- Date: `2026-04-02`
- Status: accepted
- Stable docs:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/tools.md`
  - `docs/reference/skills.md`
  - `docs/guide/features.md`
  - `docs/guide/orchestration.md`
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/journeys/operator/interactive-session.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Brewva keeps a small public delegated specialist surface and does not retain `general` as a public escape hatch. The stable built-in worker presets are `advisor`, `qa`, and `patch-worker`.
- Delegated executable QA and `runtime.verification.*` are separate concepts: QA tries to break the change; the runtime decides whether evidence is sufficient and fresh.
- Only `patch-worker` is patch-producing. `qa-runner` is effectful for execution and evidence capture, but it does not enter `WorkerResult` merge/apply semantics.
- Delegated QA evidence is first-class outcome data, not merely mirrored skill output.
- Envelope-declared tool surfaces are hard ceilings, and context narrowing is explicit through `contextProfile`.

## Superseded by

- None.
