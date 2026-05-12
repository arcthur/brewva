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
5. `ledger-writer` records durable tool outcomes (normally from SDK `tool_result`; can fallback to `tool_execution_end` when `tool_result` is missing). Persisted governance event is `tool_result_recorded`.
6. `tool-result-distiller` may replace large pure-text `tool_result` payloads with bounded same-turn summaries after raw evidence is recorded.
7. `agent_end` runs completion guard and leaves recovery sequencing to the model

## Tool Registration Modes

1. `registerTools: true` registers managed Brewva tools through hosted session assembly
2. `registerTools: false` keeps the same hosted lifecycle behavior, but tool registration is delegated to the host session setup
3. Runtime lifecycle, event streaming, context shaping, ledger finalization, and completion guard stay identical across both modes

## Runtime Subsystems

- Skills: `packages/brewva-runtime/src/domain/skills/registry.ts`
- Verification: `packages/brewva-runtime/src/domain/verification/gate.ts`
- Ledger: `packages/brewva-runtime/src/domain/ledger/evidence-ledger.ts`
- Context budget: `packages/brewva-runtime/src/domain/context/budget.ts`
- Event store: `packages/brewva-runtime/src/events/store.ts`
- Tape replay engine: `packages/brewva-runtime/src/domain/tape/replay-engine.ts`
- Cost tracker: `packages/brewva-runtime/src/domain/cost/tracker.ts`

## Custom Delegated Specialists

Delegated worker authoring now has two layers:

- built-in runtime postures live in the hosted catalog
- custom specialists live under `.brewva/subagents/*.md` or
  `~/.brewva/subagents/*.md`

Markdown worker files narrow one of the existing public specialists. The
allowed frontmatter fields are `name`, `description`, `extends`, `modelPreset`,
`reasoningEffort`, and `tools`. `extends` must be `advisor`, `qa`, or
`patch-worker`; tools must be a subset of the base envelope tools. The Markdown
body becomes additive authored instructions rendered in the delegated prompt.
Built-in specialists now follow the same authored-behavior model through
catalog-backed constitutions instead of relying only on thin preambles.
Authority still comes from the normalized hosted catalog, not from ad hoc
prompt text outside the narrowing rules.

Custom specialists cannot declare `model`, `envelope`, `skillName`,
`defaultConsultKind`, `reviewLane`, `fallbackResultMode`, or
`executorPreamble`. Invalid frontmatter is a hard error, not a warning.

## Inspectable Delegation Routing

Delegated model routing stays in the hosted control plane rather than the
runtime kernel.

- public callers provide `skillName` intent and packet fields
- the resolver derives internal agent spec, envelope, result kind, consult kind,
  context profile, adoption contract, and model route
- maintainer-only `subagent_run_diagnostic` can still probe explicit low-level
  routing fields
- active presets and policy routes select child-session models
- route decisions are persisted on the delegation record so
  `subagent_status(detailMode=diagnostic)` can report the selected model,
  source, policy id, and rationale without leaking those fields into the
  default public view

This keeps delegated routing visible and reviewable instead of turning it into a
hidden planner.

## Specialist Cutover Snapshot

The current stable built-in specialist surface is:

- public specialists: `advisor`, `qa`, `patch-worker`
- internal review fan-out lanes remain behind the review ensemble and are not
  part of the public specialist taxonomy

Execution posture is intentionally split:

- `advisor` is the single public read-only consultation identity and runs under
  the minimal-context `readonly-advisor` envelope
- public consult intent derives `investigate`, `diagnose`, `design`, or
  `review` internally; only diagnostics select consult kind directly
- consult runs do not make the child own semantic skill completion; parent
  skills still emit semantic workflow artifacts such as `workflow.design` and
  `workflow.review`
- `qa` is effectful for commands, browser flows, and evidence capture, but it
  is non-patch-producing and does not enter `WorkerResult` adoption semantics
- `qa` is intentionally adversarial: a `pass` posture depends on evidence-backed
  executed checks, not static code reading or inherited implementer confidence
- `patch-worker` is the isolated patch-producing specialist
- `subagent_fork` is an execution primitive rather than a specialist; it
  records parent lineage, context policy, and `executionPrimitive=fork`
- hosted envelopes also pin `contextProfile`; `advisor` and `qa`
  default to `minimal`, while `patch-worker` uses `standard`
- hosted envelopes also pin `isolationStrategy`:
  `readonly-advisor=shared`, `qa-runner=ephemeral`, and
  `patch-worker=snapshot`
- `minimal` still keeps the recovery-critical baseline pair
  (`historyViewBaseline` + `recoveryWorkingSet`); it only drops the broader
  runtime-status and working-projection narrative set
- the review ensemble keeps internal evidence-audit coverage for stale
  evidence, missing probes, rollback posture, and operator-visible recovery
  burden

`runtime.authority.verification.*` remains kernel authority over evidence sufficiency and
freshness. It is not a delegated specialist.

## Inspectable Stall Adjudication

Stall detection still starts with `runtime.maintain.session.pollStall(...)`, but the
gateway worker now adds a second, inspectable adjudication step.

- `task_stuck_detected` remains the idle-threshold detection signal
- the worker builds a bounded inspection packet from task state, verification
  state, tape pressure, recent failed tool outcomes, blocked tool calls, and
  pending worker results
- the adjudicator records a durable `task_stall_adjudicated` event with
  `continue`, `steer`, `compact_recommended`, or `abort_recommended`
- inspection surfaces such as `workflow_status` can expose that recommendation
  together with planning assurance posture such as `plan_complete`,
  `plan_fresh`, `review_required`, `qa_required`, and
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
- `/answer` records `operator_question_answered` and routes the answer back into
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
