# Decision: Specialist Subagents And Adversarial Verification

## Metadata

- Decision: Superseded. Brewva no longer uses the original three-role public delegated specialist surface from this decision.
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

- Brewva still keeps a small public delegated specialist surface and does not retain `general` as a public escape hatch, but the original three-role surface from this decision has been replaced by Subagent Orchestration V2.
- Delegated executable Verifier and `runtime.verification.*` are separate concepts: Verifier tries to break the change; the runtime decides whether evidence is sufficient and fresh.
- Only the public worker role is patch-producing. Verifier is effectful for execution and evidence capture, but it does not enter `WorkerResult` merge/apply semantics.
- Delegated Verifier evidence is first-class outcome data, not merely mirrored skill output.
- Envelope-declared tool surfaces are hard ceilings. Passive `contextProfile` narrowing is no longer part of the envelope contract; hosted context narrowing is owned by the gateway materialization module.

## Superseded by

- `docs/research/decisions/hosted-context-materialization-ownership.md`
- `docs/research/decisions/subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md`
