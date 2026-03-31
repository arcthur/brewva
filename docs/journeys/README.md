# Journeys

`docs/journeys/` is organized around two reading modes:

- `operator/`
  - User-visible product entrypoints and operator workflows
  - Answers questions such as "Which command or control surface starts this flow?"
- `internal/`
  - Cross-package mechanism flows for implementation review
  - Answers questions such as "Which packages own this path, what recovers it, and which state is authoritative?"

## Reading Order

Start with `operator/` when you are reviewing CLI behavior, gateway lifecycle,
approval handling, channel behavior, scheduling, or incident entrypoints.

Start with `internal/` when you are reviewing runtime internals, hosted runtime
plugins, WAL behavior, compaction, or other cross-package recovery mechanics.

## Standard Pattern

Every journey follows the same structure:

1. `Audience`
2. `Entry Points`
3. `Objective`
4. `In Scope`
5. `Out Of Scope`
6. `Flow`
7. `Key Steps`
8. `Execution Semantics`
9. `Failure And Recovery`
10. `Observability`
11. `Code Pointers`
12. `Related Docs`

## Terminology Baseline

Use the repository's contract words consistently:

- `durable source of truth`: authoritative replay and audit surfaces
- `durable transient`: bounded recovery or rollback material
- `rebuildable state`: persisted derived state rebuilt from durable truth
- `event tape`: replayable per-session event stream
- `PatchSet`: tracked file-change artifact used by rollback and worker adoption
- `hosted session`: the runtime-bearing session created by the host
- `control plane` as a noun, `control-plane` as an adjective
- `inspection surface`: an explicit read model or tool such as `workflow_status`
- `workflow posture`: derived advisory workflow state surfaced by tools such as
  `workflow_status`
- `child session`: a scheduler- or delegation-owned descendant session

Each journey should:

- name concrete entrypoints instead of only describing mechanisms
- state its boundaries explicitly so replay, workflow, projection, and recovery
  topics do not bleed across pages
- include a mermaid flow so reviewers can see the cross-package spine quickly
- include recovery and observability details instead of documenting only the
  happy path
