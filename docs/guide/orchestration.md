# Orchestration

Orchestration is driven by runtime state management plus runtime-plugin lifecycle handlers.

- Runtime governance facade and service wiring: `packages/brewva-runtime/src/runtime.ts`
- Runtime plugin registration: `@brewva/brewva-gateway/runtime-plugins` (`packages/brewva-gateway/src/runtime-plugins/index.ts`)

## Hosted Pipeline

1. Gateway host creates a session (`@brewva/brewva-gateway/host`, implemented in `packages/brewva-gateway/src/host/create-hosted-session.ts`)
2. Gateway host installs `createHostedTurnPipeline` (`@brewva/brewva-gateway/runtime-plugins`)
3. `before_agent_start` runs lifecycle plumbing (`context-transform`) and model-facing composition (`context-composer`)
4. `tool_call` passes quality/security/budget gates (`quality-gate`)
5. `ledger-writer` records durable tool outcomes (normally from SDK `tool_result`; can fallback to `tool_execution_end` when `tool_result` is missing). Persisted governance event is `tool_result_recorded`.
6. `tool-result-distiller` may replace large pure-text `tool_result` payloads with bounded same-turn summaries after raw evidence is recorded.
7. `agent_end` runs completion guard and leaves recovery sequencing to the model

## Tool Registration Modes

1. `registerTools: true` registers managed Brewva tools through the hosted pipeline
2. `registerTools: false` keeps the same hosted lifecycle pipeline, but tool registration is delegated to the host session setup
3. Runtime lifecycle, event streaming, context shaping, ledger finalization, and completion guard stay identical across both modes

## Runtime Subsystems

- Skills: `packages/brewva-runtime/src/skills/registry.ts`
- Verification: `packages/brewva-runtime/src/verification/gate.ts`
- Ledger: `packages/brewva-runtime/src/ledger/evidence-ledger.ts`
- Context budget: `packages/brewva-runtime/src/context/budget.ts`
- Event store: `packages/brewva-runtime/src/events/store.ts`
- Tape replay engine: `packages/brewva-runtime/src/tape/replay-engine.ts`
- Cost tracker: `packages/brewva-runtime/src/cost/tracker.ts`

## Delegated Worker Overlays

Delegated worker authoring now has two layers:

- runtime postures remain JSON-backed under `.brewva/subagents/*.json`
- authored worker overlays live under `.brewva/agents/*.md` or
  `.config/brewva/agents/*.md`

Markdown worker files compile into the existing hosted `agentSpec` surface. The
frontmatter controls the structural fields (`name`, `extends`, `envelope`,
`skillName`, `fallbackResultMode`, `executorPreamble`), while the Markdown body
becomes additive authored instructions rendered in the delegated prompt.
Built-in specialists now follow the same authored-behavior model through
catalog-backed constitutions instead of relying only on thin preambles.
Authority still comes from the normalized hosted catalog, not from ad hoc
prompt text outside the narrowing rules.

Overlay frontmatter is canonical-only. Worker kind values, envelope names, and
goal-loop style protocol fields do not keep compatibility aliases in this
surface.

## Inspectable Delegation Routing

Delegated model routing stays in the hosted control plane rather than the
runtime kernel.

- explicit `executionShape.model` remains the highest-priority override
- envelope-pinned models remain explicit target defaults
- when neither is present, the gateway may auto-apply a policy-backed route for
  child sessions
- route decisions are persisted on the delegation record so
  `subagent_status` can report the selected model, source, policy id, and
  rationale

This keeps delegated routing visible and reviewable instead of turning it into a
hidden planner.

## Specialist Cutover Snapshot

The current stable built-in specialist surface is:

- public specialists: `explore`, `plan`, `review`, `qa`, `patch-worker`
- internal review fan-out lanes:
  `review-correctness`, `review-boundaries`, `review-operability`,
  `review-security`, `review-concurrency`, `review-compatibility`, and
  `review-performance`

Execution posture is intentionally split:

- `explore`, `plan`, and `review` are read-only and run under minimal-context
  envelopes
- `plan` is a first-class delegated result posture; canonical plan outcomes
  carry `designSpec`, `executionPlan`, `executionModeHint`, `riskRegister`, and
  `implementationTargets`, and the gateway projects that payload into the
  downstream `design` skill artifact set
- `qa` is effectful for commands, browser flows, and evidence capture, but it
  is non-patch-producing and does not enter `WorkerResult` adoption semantics
- `qa` is intentionally adversarial: a `pass` posture depends on evidence-backed
  executed checks, not static code reading or inherited implementer confidence
- `patch-worker` is the isolated patch-producing specialist
- hosted envelopes also pin `contextProfile`; read-only specialists and `qa`
  default to `minimal`, while `patch-worker` uses `standard`
- `review-operability` remains the internal audit lane for stale evidence,
  missing probes, rollback posture, and operator-visible recovery burden

`runtime.verification.*` remains kernel authority over evidence sufficiency and
freshness. It is not a delegated specialist.

## Inspectable Stall Adjudication

Stall detection still starts with `runtime.session.pollStall(...)`, but the
gateway worker now adds a second, inspectable adjudication step.

- `task_stuck_detected` remains the idle-threshold detection signal
- the worker builds a bounded inspection packet from task state, verification
  state, tape pressure, recent failed tool outcomes, blocked tool calls, and
  pending worker results
- the adjudicator records a durable `task_stall_adjudicated` event with
  `continue`, `nudge`, `compact_recommended`, or `abort_recommended`
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

- `/questions` inspects unresolved session questions derived from durable
  `skill_completed` outputs and delegated exploration outcome artifacts
- `/answer` records `operator_question_answered` and routes the answer back into
  the active session as explicit operator input
- `/agent-overlays` inspects and validates Markdown-authored delegated-worker
  overlays against the hosted catalog narrowing rules

This keeps questionnaire flow, authored overlay inspection, and delegated
worker ergonomics in the control plane. The runtime kernel still owns replay,
governance, rollback, and event truth.
