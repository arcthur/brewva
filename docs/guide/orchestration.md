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
- authored worker overlays live under `.brewva/agents/*.md`

Markdown worker files compile into the existing hosted `agentSpec` surface. The
frontmatter controls the structural fields (`name`, `extends`, `envelope`,
`skillName`, `fallbackResultMode`, `executorPreamble`), while the Markdown body
becomes additive authored instructions rendered in the delegated prompt.
Authority still comes from the normalized hosted catalog, not from ad hoc prompt
text outside the narrowing rules.

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
