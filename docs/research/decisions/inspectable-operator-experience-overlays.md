# Decision: Inspectable Operator-Experience Overlays

## Metadata

- Decision: Ergonomics compile back to durable primitives. Model routing, questionnaire flow, delegated-run inspection, and authored worker overlays remain control-plane veneers over explicit runtime, delegation, event, and workflow surfaces.
- Date: `2026-03-28`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/reference/commands.md`
  - `docs/reference/extensions.md`
  - `docs/reference/skills.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events/README.md`
  - `docs/guide/orchestration.md`
  - `docs/guide/cli.md`
- Code anchors:
  - `packages/brewva-gateway/src/delegation/model-routing.ts`
  - `packages/brewva-gateway/src/delegation/catalog/registry.ts`
  - `packages/brewva-gateway/src/delegation/config-files.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/watchdog/task-stall-adjudication.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/watchdog/task-progress-watchdog.ts`
  - `packages/brewva-gateway/src/operator-questions.ts`
  - `packages/brewva-gateway/src/agent-overlay-inspection.ts`
  - `packages/brewva-gateway/src/channels/command-router.ts`

## Decision Summary

- Ergonomics compile back to durable primitives. Model routing, questionnaire flow, delegated-run inspection, and authored worker overlays remain control-plane veneers over explicit runtime, delegation, event, and workflow surfaces.
- Automatic decisions stay inspectable. Delegated model routes persist source, mode, rationale, and policy identity. Stall adjudication persists a durable decision packet instead of silently mutating session state.
- Authored overlays stay narrowing-only and canonical-only. Markdown worker files are an authoring surface, not an authority bypass. They compile into the hosted catalog and do not keep legacy aliases for kinds, field names, or envelope names.
- Operator answers remain replay-visible. `/questions` derives unresolved questions from durable skill outputs and delegated consult outcomes. `/answer` records `operator.question.answered` and routes the answer back as explicit operator input.
- Workflow acceleration stays bounded and policy-respecting. `ci-iteration` demonstrates explicit retry, verification, and handoff posture without turning Brewva into a hidden planner or merge authority.

## Superseded by

- `docs/research/decisions/cli-tui-experience-ring-decomposition-and-shell-port-boundaries.md` supersedes the renderer contract portions of this decision.
