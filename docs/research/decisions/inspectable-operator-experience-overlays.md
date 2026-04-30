# Decision: Inspectable Operator-Experience Overlays

## Metadata

- Decision: Ergonomics compile back to durable primitives. Model routing, questionnaire flow, delegated-run inspection, and authored worker overlays remain control-plane veneers over explicit runtime, delegation, event, and workflow surfaces.
- Date: `2026-03-28`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/reference/commands.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/skills.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events/README.md`
  - `docs/guide/orchestration.md`
  - `docs/guide/cli.md`
- Code anchors:
  - `packages/brewva-gateway/src/subagents/model-routing.ts`
  - `packages/brewva-gateway/src/subagents/catalog.ts`
  - `packages/brewva-gateway/src/subagents/config-files.ts`
  - `packages/brewva-gateway/src/session/task-stall-adjudication.ts`
  - `packages/brewva-gateway/src/session/task-progress-watchdog.ts`
  - `packages/brewva-gateway/src/operator-questions.ts`
  - `packages/brewva-gateway/src/agent-overlay-inspection.ts`
  - `packages/brewva-gateway/src/channels/command-router.ts`

## Decision Summary

- Ergonomics compile back to durable primitives. Model routing, questionnaire flow, delegated-run inspection, and authored worker overlays remain control-plane veneers over explicit runtime, delegation, event, and workflow surfaces.
- Automatic decisions stay inspectable. Delegated model routes persist source, mode, rationale, and policy identity. Stall adjudication persists a durable decision packet instead of silently mutating session state.
- Authored overlays stay narrowing-only and canonical-only. Markdown worker files are an authoring surface, not an authority bypass. They compile into the hosted catalog and do not keep legacy aliases for kinds, field names, or envelope names.
- Operator answers remain replay-visible. `/questions` derives unresolved questions from durable skill outputs and delegated consult outcomes. `/answer` records `operator_question_answered` and routes the answer back as explicit operator input.
- Workflow acceleration stays bounded and policy-respecting. `ci-iteration` demonstrates explicit retry, verification, and handoff posture without turning Brewva into a hidden planner or merge authority.

## Superseded by

- None.
