# Orchestration

Orchestration is driven by runtime state management plus hosted lane behavior.

- Runtime governance facade and service wiring: `packages/brewva-runtime/src/runtime/runtime.ts`
- Hosted session entrypoint: `@brewva/brewva-gateway/hosted` (`packages/brewva-gateway/src/hosted/api.ts`)
- Opt-in extension facade: `@brewva/brewva-gateway/extensions` (`packages/brewva-gateway/src/extensions/api.ts`)

This guide focuses on the hosted lane, delegated worker routing, and
operator-visible control-plane behavior. For extension and session lifecycle
details, use:

- `docs/reference/extensions.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/runtime.md`

## Current Guarantees And Non-Goals

The current orchestration stack is a control-plane product over kernel-owned
receipts. It is not a distributed transaction coordinator.

Current stable guarantees:

- delegated runs, schedule wakeups, and control routing remain inspectable and
  replay-visible where they write durable receipts
- parent-side adoption stays explicit through tools such as
  `worker_results_apply`
- control-plane routing remains subordinate to runtime governance, rollback,
  and event truth

Current non-goals:

- no cross-agent saga semantics
- no generalized compensation graph
- no automatic partial-failure repair across fan-out or parent/child runs
- no default-path backpressure guarantee beyond the bounded limits documented
  elsewhere in config and runtime surfaces

Platform-growth rule:

- new multi-agent breadth should remain opt-in control-plane behavior rather
  than widening the default hosted path
- explicit tools, channel orchestration config, or host-owned routing choices
  are acceptable opt-in surfaces; hidden default-path orchestration growth is
  not

## Hosted Lane

1. Gateway host creates a session through the stable host entrypoint
   `@brewva/brewva-gateway/hosted`
   (`packages/brewva-gateway/src/hosted/api.ts`), with the current implementation in
   `packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts`
2. Gateway session assembly privately installs hosted behavior through substrate host-api adapters
3. `before_agent_start` runs lifecycle plumbing (`context-transform`) and renders the hosted dynamic context tail
4. `tool_call` passes quality/security/budget gates (`quality-gate`)
5. `ledger-writer` records durable tool outcomes (normally from SDK `tool_result`; can fallback to `tool_execution_end` when `tool_result` is missing). Persisted governance event is `tool.result.recorded`.
6. `tool-result-distiller` may replace large pure-text `tool_result` payloads with bounded same-turn summaries after raw evidence is recorded.
7. `agent_end` runs completion guard and leaves recovery sequencing to the
   runtime turn loop

## Tool Registration Modes

1. `registerTools: true` registers managed Brewva tools through hosted session assembly
2. `registerTools: false` keeps the same hosted lifecycle behavior, but tool registration is delegated to the host session setup
3. Runtime lifecycle, event streaming, context shaping, ledger finalization, and completion guard stay identical across both modes

## Runtime Subsystems

- Skills: `packages/brewva-runtime/src/runtime/model/impl.ts`
- Verification: `packages/brewva-runtime/src/runtime/kernel/impl.ts`
- Ledger projection: `packages/brewva-runtime/src/runtime/tape/impl.ts`
- Context budget: `packages/brewva-runtime/src/runtime/model/impl.ts`
- Event records: `packages/brewva-runtime/src/runtime/tape/impl.ts`
- Tape replay engine: `packages/brewva-runtime/src/runtime/tape/impl.ts`
- Cost tracker: `packages/brewva-runtime/src/runtime/tape/impl.ts`

## Custom Delegated Specialists

Delegated worker authoring has two layers:

- built-in runtime postures live in the hosted catalog
- custom specialists live under `.brewva/subagents/*.md` or
  `~/.brewva/subagents/*.md`

Markdown worker files narrow one of the existing public specialists. The
recognized frontmatter fields are `name`, `description`, `extends`, `modelPreset`,
`reasoningEffort`, and `tools`. `extends` must be one of `navigator`,
`explorer`, `worker`, `verifier`, or `librarian`; tools must be a subset of the base
role's managed-tool set. The Markdown body becomes additive authored
instructions rendered in the delegated prompt. Built-in specialists follow the
same authored-behavior model through catalog-backed constitutions. Authority
still comes from the normalized hosted catalog, not from ad hoc prompt text
outside the narrowing rules.

Custom specialists cannot declare `model`, `envelope`, `skillName`,
`defaultConsultKind`, `reviewLane`, `fallbackResultMode`, or
`executorPreamble`. Invalid frontmatter is a hard error, not a warning.

## Inspectable Delegation Routing

Delegated model routing stays in the hosted control plane rather than the
runtime kernel.

- public callers provide `agent` plus optional compatible `skillName` intent and
  packet fields
- the resolver derives internal target, envelope, result kind, consult kind when
  applicable, managed-tool set, adoption contract, and model route
- maintainer-only `subagent_run_diagnostic` can still probe explicit low-level
  routing fields
- active presets and policy routes select child-session models
- route decisions are persisted on the delegation record so
  `subagent_status(detailMode=diagnostic)` can report the selected model,
  source, policy id, and rationale without leaking those fields into the
  default public view

This keeps delegated routing visible and reviewable instead of turning it into a
hidden planner.

Pending delegation work projects onto an adoption board over the same
inspection state: adoption items (worker patches and knowledge proposals,
each naming the tools that resolve it) are kept distinct from advisory
attention items (unconsumed evidence, verifier debt, blocked or failed runs).
`workflow_status` surfaces it; the board owns no truth and resolves nothing
itself.

## Delegation Measurement Loop

`bun run report:delegation-evidence [workspace] [--session <id>...]` grades the
delegation surface from the tape, explicit-pull and rebuildable — reach by role,
primitive, and wait mode; parallel-gate rejections by reason; adoption outcomes;
and a delegation FAILURE rate (dispatch, spawn, consult). The failure rate is the
reliability counter-signal to any activation gain: a doctrine that lifts reach
while dispatches fail is pushing the model into a wall, not adoption. The report
auto-applies nothing — it is the instrument that calibrates whether a doctrine
change actually moved the trigger rate, before and after, rather than assuming so.

## Specialist Cutover Snapshot

The current stable built-in specialist surface is:

- public specialists: `navigator`, `explorer`, `worker`, `verifier`, and `librarian`
- review runs go through `review_request`'s single bounded fresh-context
  reviewer; there is no internal lane fan-out planner

For each role's execution posture and the three execution archetypes
(`readonly-shared`, `exec-ephemeral`, `patch-snapshot`), see
`docs/journeys/operator/background-and-parallelism.md` (Execution Semantics).
Orchestration-specific notes on top of that:

- consult runs do not make the child own semantic completion; the parent
  session retains ownership of task truth and artifact adoption
- hosted context shape is owned by gateway materialization policy, not by a
  passive envelope profile field
- recovery-critical baseline materialization (`historyViewBaseline`) is preserved
  by the gateway context materializer when the hosted lane needs it
- `review_request`'s single reviewer covers evidence-audit concerns (stale
  evidence, missing probes, rollback posture) as one bounded consult, not a
  multi-lane ensemble

`HostedRuntimeAdapterPort.ops.verification.*` remains the repo-owned adapter for
evidence sufficiency and freshness. It is not a delegated specialist, and new
consequence-bearing runtime work should move through `runtime.kernel`.

## Inspectable Stall Adjudication

Stall detection still starts with the hosted runtime ops adapter, but the
gateway worker adds a second, inspectable adjudication step.

- `task_stuck_detected` remains the idle-threshold detection signal
- the worker builds a bounded inspection packet from task state, verification
  state, tape pressure, recent failed tool outcomes, blocked tool calls, and
  pending worker results
- the adjudicator records a durable `task_stall_adjudicated` event with
  `continue`, `steer`, `compact_recommended`, or `abort_recommended`
- inspection surfaces such as `workflow_status` can expose that recommendation
  together with planning assurance posture such as `plan_complete`,
  `plan_fresh`, `review_required`, `verifier_required`, and
  `unsatisfied_required_evidence`, without turning any of it into hidden
  autonomous session control

The current default policy is heuristic, but the durable packet and event shape
are stable enough for future hook-backed or model-backed adjudicators without
changing the inspection contract.

## Thin Operator Question And Overlay Surfaces

The overlay/operator RFC is now closed through thin command veneers rather than
new kernel state:

- interactive `/inbox` and headless `/questions` both inspect the operator
  inbox derived from durable task, verification, and delegated consult outcome
  artifacts
- `/answer` records `operator.question.answered` and routes the answer back into
  the active session as explicit operator input
- `/agent-overlays` inspects and validates Markdown-authored delegated-worker
  overlays against the hosted catalog narrowing rules

This keeps questionnaire flow, authored overlay inspection, and delegated
worker ergonomics in the control plane. The runtime kernel still owns replay,
governance, rollback, and event truth.

## Related Docs

- `docs/guide/understanding-runtime-system.md`
- `docs/guide/channel-agent-workspace.md`
- `docs/journeys/operator/interactive-session.md`
- `docs/journeys/operator/background-and-parallelism.md`
- `docs/reference/extensions.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/runtime.md`
