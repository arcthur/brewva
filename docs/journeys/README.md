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

## Coverage Map

This map is the source of truth for what has a journey today. Absence below is a
tracked gap, not an oversight: a path is either covered or explicitly listed as
not-yet-journeyed with the doc to read meanwhile.

### Covered

| Surface / path                         | Journey                                            | Axis     |
| -------------------------------------- | -------------------------------------------------- | -------- |
| Interactive session                    | `operator/interactive-session.md`                  | operator |
| Channel gateway and turn flow          | `operator/channel-gateway-and-turn-flow.md`        | operator |
| Gateway control-plane lifecycle        | `operator/gateway-control-plane-lifecycle.md`      | operator |
| Approval and rollback                  | `operator/approval-and-rollback.md`                | operator |
| Background and parallelism             | `operator/background-and-parallelism.md`           | operator |
| Intent-driven scheduling               | `operator/intent-driven-scheduling.md`             | operator |
| Inspect, replay, and recovery          | `operator/inspect-replay-and-recovery.md`          | operator |
| MCP tool integration                   | `operator/mcp-tool-integration.md`                 | operator |
| ACP client ingress                     | `operator/acp-client-ingress.md`                   | operator |
| Skill routing and activation           | `operator/skill-routing-and-activation.md`         | operator |
| Recall and knowledge compounding       | `operator/recall-and-knowledge-compounding.md`     | operator |
| Context and compaction                 | `internal/context-and-compaction.md`               | internal |
| WAL and crash recovery                 | `internal/wal-and-crash-recovery.md`               | internal |
| Provider turn, streaming, and fallback | `internal/provider-turn-streaming-and-fallback.md` | internal |
| Hosted behavior installation           | `internal/hosted-behavior-installation.md`         | internal |

### Not Yet Journeyed

No tracked gaps right now: every major path above has a journey. When a new
cross-package path appears without one, list it here with its axis and the
reference or guide doc to use in the meantime, so its absence reads as a tracked
gap rather than an oversight.

## Standard Pattern

Every journey carries the same required core sections, in this order:

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

A journey may add optional sections when a path needs them. Place any optional
section after `Failure And Recovery` and before `Observability`. Optional
sections currently in use:

- `Enforced Claims`: authority-bearing claims pinned to live fitness tests, each
  with a stable id and a drift guard that keeps the documented list and the test
  registry identical (see `operator/background-and-parallelism.md`)
- `Interactive Task Review`: operator-facing review UX specific to one surface
  (see `operator/background-and-parallelism.md`)

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
