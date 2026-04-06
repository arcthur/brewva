# Research: Inspectable Operator-Experience Overlays

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-28`
- Promotion target:
  - `docs/reference/tools.md`
  - `docs/reference/commands.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/skills.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events.md`
  - `docs/guide/orchestration.md`
  - `docs/guide/cli.md`
  - `docs/journeys/operator/background-and-parallelism.md`

## Promotion Summary

This note is now a short status pointer.

The decision has been promoted: Brewva adopts Pi-style operator ergonomics only
when they can be expressed as explicit, inspectable, replay-visible
control-plane overlays rather than hidden convenience magic.

Stable implementation now includes:

- inspectable delegated model routing with explicit route metadata, rationale,
  and override precedence
- durable stall adjudication through `task_stall_adjudicated` rather than a
  hidden autonomous watchdog helper
- Markdown-authored delegated-worker overlays under `.brewva/agents/*.md` and
  `.config/brewva/agents/*.md`, compiled into the hosted `agentSpec` /
  `ExecutionEnvelope` catalog with narrowing-only validation
- thin operator command veneers for `/cost`, `/questions`, `/answer`, and
  `/agent-overlays`
- a durable `operator_question_answered` receipt for questionnaire answers
- a bounded `ci-iteration` domain skill as the workflow-showcase example for
  PR / CI repair loops

Stable references:

- `docs/reference/tools.md`
- `docs/reference/commands.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/skills.md`
- `docs/reference/configuration.md`
- `docs/reference/events.md`
- `docs/guide/orchestration.md`
- `docs/guide/cli.md`
- `docs/journeys/operator/background-and-parallelism.md`

## Stable Contract Summary

The promoted contract is:

1. Ergonomics compile back to durable primitives.
   Model routing, questionnaire flow, delegated-run inspection, and authored
   worker overlays remain control-plane veneers over explicit runtime,
   delegation, event, and workflow surfaces.
2. Automatic decisions stay inspectable.
   Delegated model routes persist source, mode, rationale, and policy identity.
   Stall adjudication persists a durable decision packet instead of silently
   mutating session state.
3. Authored overlays stay narrowing-only and canonical-only.
   Markdown worker files are an authoring surface, not an authority bypass.
   They compile into the hosted catalog and do not keep legacy aliases for
   kinds, field names, or envelope names.
4. Operator answers remain replay-visible.
   `/questions` derives unresolved questions from durable skill outputs and
   delegated consult outcomes. `/answer` records
   `operator_question_answered` and routes the answer back as explicit operator
   input.
5. Workflow acceleration stays bounded and policy-respecting.
   `ci-iteration` demonstrates explicit retry, verification, and handoff
   posture without turning Brewva into a hidden planner or merge authority.
6. Removed compatibility paths stay removed.
   This promoted surface does not restore generic self-command injection,
   process-local background helpers, file-backed todos, or compatibility shims
   for retired aliases.

## Validation Status

Promotion is backed by:

- hosted delegated model-routing implementation and coverage
- durable stall adjudication packet / inspection coverage
- Markdown overlay parsing and narrowing-validator coverage
- interactive and channel command coverage for `/questions`, `/answer`, and
  `/agent-overlays`
- stable docs aligned across commands, runtime plugins, tools, events, skills,
  configuration, orchestration, and delegation journeys
- full repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`

## Source Anchors

- `packages/brewva-gateway/src/subagents/model-routing.ts`
- `packages/brewva-gateway/src/subagents/catalog.ts`
- `packages/brewva-gateway/src/subagents/config-files.ts`
- `packages/brewva-gateway/src/session/task-stall-adjudication.ts`
- `packages/brewva-gateway/src/session/task-progress-watchdog.ts`
- `packages/brewva-gateway/src/operator-questions.ts`
- `packages/brewva-gateway/src/agent-overlay-inspection.ts`
- `packages/brewva-gateway/src/channels/command-router.ts`
- `packages/brewva-gateway/src/channels/host.ts`
- `packages/brewva-cli/src/questions-command-runtime-plugin.ts`
- `packages/brewva-cli/src/agent-overlays-command-runtime-plugin.ts`
- `packages/brewva-cli/src/questions-channel-command.ts`
- `packages/brewva-runtime/src/events/event-types.ts`
- `packages/brewva-tools/src/subagent-control.ts`
- `packages/brewva-tools/src/workflow-status.ts`
- `skills/domain/ci-iteration/SKILL.md`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- generic `execute_command`-style self-command injection
- file-backed todos as canonical task state
- process-local background helpers as the canonical delegation model
- keyword-only model auto-routing with no inspectable rationale
- a hidden planner or default-push workflow brief built on top of these
  operator surfaces

If future work reopens any of those directions, it should start from a new
focused RFC rather than expanding this promoted status pointer.

## Historical Notes

- Historical option analysis and rollout detail were removed from this file
  after promotion.
- The stable contract now lives in reference, guide, and journey docs plus the
  regression suite rather than in `docs/research/`.
