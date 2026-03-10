# Reference: Extensions

Extension factory entrypoint: `packages/brewva-extensions/src/index.ts`.

Control-plane broker entrypoint: `packages/brewva-skill-broker/src/index.ts`.

Shared deliberation helpers: `packages/brewva-deliberation/src/index.ts`.

## Factory API

- `createBrewvaExtension`
- `brewvaExtension`

Factory options:

- `registerTools?: boolean` (default `true`)

## Registered Handlers

Default extension composition wires:

- `registerEventStream`
- `registerToolSurface`
- `registerCognitionSediment`
- `registerContextTransform`
- `registerScanConvergenceGuard`
- `registerQualityGate`
- `registerDebugLoop`
- `registerLedgerWriter`
- `registerCompletionGuard`
- `registerNotification`

Implementation files:

- `packages/brewva-extensions/src/event-stream.ts`
- `packages/brewva-extensions/src/tool-surface.ts`
- `packages/brewva-extensions/src/cognition-sediment.ts`
- `packages/brewva-extensions/src/context-transform.ts`
- `packages/brewva-extensions/src/scan-convergence-guard.ts`
- `packages/brewva-extensions/src/quality-gate.ts`
- `packages/brewva-extensions/src/debug-loop.ts`
- `packages/brewva-extensions/src/ledger-writer.ts`
- `packages/brewva-extensions/src/completion-guard.ts`
- `packages/brewva-extensions/src/notification.ts`

## Tool Surface Resolution

`registerToolSurface` runs before context injection and narrows the visible
tool list for the current turn.

Resolution inputs:

- built-in always-on tools
- Brewva base governance tools
- tools declared by the current active/pending/cascade skill contracts
- operator/full routing profiles
- explicit capability requests such as `$obs_query`

The extension updates only the active tool surface. Runtime policy, contract,
and compaction gates still decide whether execution is actually allowed.

Default behavior is intentionally asymmetric:

- explicit `$name` requests always expand capability details in the context block
- only hidden operator tools are surfaced by that request path
- hidden skill tools still require an actual skill commitment (active, pending,
  or cascade) before they become visible

This keeps capability disclosure useful without turning `$name` into a hidden
tool-activation bypass.

Telemetry:

- `tool_surface_resolved`

## Scan Convergence Guard

Scan convergence is now a runtime governance service. The extension bridge only
forwards turn-end lifecycle into runtime; the actual classification, blocker
writes, event emission, restart hydration, and tool-call blocking happen inside
runtime services (`runtime.tools.start(...)`, `runtime.tools.finish(...)`,
`runtime.context.onUserInput(...)`, `runtime.context.onTurnEnd(...)`).

The runtime service classifies retrieval behavior into four tool strategies:

- `raw_scan`: `read`, `grep`
- `low_signal`: `look_at`, `read_spans`, `toc_document`, `toc_search`, `ast_grep_search`, selected `lsp_*` navigation tools, and low-signal `exec` commands such as `ls`/`find`/`cat`/`rg`
- `evidence_reuse`: `output_search`, `ledger_query`, `obs_query`, `obs_slo_assert`, `obs_snapshot`, `tape_info`, `tape_search`, `task_view_state`, `cost_view`
- `progress`: task mutation tools, skill lifecycle tools, handoff/mutation tools, and the remaining non-retrieval surface

The guard arms when a session accumulates repeated:

- `read`/`grep`-only turns
- low-signal investigation-only turns
- ENOENT / out-of-bounds raw scan failures

When armed, runtime:

- blocks additional `raw_scan` and `low_signal` tool calls
- records the task blocker `guard:scan-convergence`, which moves task status to `phase=blocked`
- resets only after a successful `evidence_reuse` or `progress` tool completion, or after fresh user input

This keeps the runtime aligned with the working-projection/task-ledger model: summarize current evidence first, then use task state or prior artifacts before resuming more retrieval.

`registerLedgerWriter` additionally persists tool-output observability events:

- `tool_output_observed`
- `tool_output_artifact_persisted`
- `tool_output_distilled`

## Automatic Debug Loop

`registerDebugLoop` is an extension-side controller, not a runtime-kernel
service.

Its current responsibilities are:

- observe `skill_complete` inputs for active `implementation` sessions
- react to `verification_outcome_recorded` failures from `runtime.verification.*`
- persist deterministic debug-loop artifacts under `.orchestrator/artifacts/`
- submit `skill_chain_intent` proposals for `runtime-forensics -> debugging -> implementation`
  (or `debugging -> implementation` when `runtime_trace` already exists), then
  react to the kernel receipt instead of mutating cascade state directly
- publish short-lived `context_packet` summaries under `.brewva/cognition/summaries/`
  with a stable `packetKey=debug-loop:status`, so the latest retry/handoff
  summary can cross the proposal boundary without becoming kernel-owned memory
- synthesize deterministic `handoff.json` packets on `agent_end` and `session_shutdown`

The controller deliberately does not mutate `skill_complete` validation rules.
Minimum artifact-shape enforcement happens inside the controller before it
schedules the next retry or writes terminal handoff state.

`retryCount` is the number of scheduled retries after the first failed
implementation verification. The initial failure snapshot therefore persists
with `retryCount=0`.

`handoff.json` is latest-wins. Repeated lifecycle persistence overwrites the
previous handoff packet for the same session instead of keeping a history log.

Artifact persistence is fail-loud:

- successful writes emit `debug_loop_failure_case_persisted` /
  `debug_loop_handoff_persisted`
- failed writes emit `debug_loop_artifact_persist_failed` with the file kind and
  absolute path, so durability gaps still leave replayable evidence

When debug-loop emits a cognition summary packet:

- it stays in the Deliberation/Experience side as a `.brewva/cognition/summaries/*`
  artifact plus a `context_packet` proposal
- it uses the `status_summary` profile instead of free-form packet prose
- packet injection is scoped by the current leaf `scopeId` when available
- later retry/handoff summaries replace earlier ones during injection via the
  stable packet key instead of mutating kernel truth/task state
- terminal debug-loop handoff persistence may also write a longer-lived
  reference artifact under `.brewva/cognition/reference/` so later sessions can
  rehydrate the terminal investigation state through the proposal boundary

## Cognition Sediment

`registerCognitionSediment` is a control-plane rehydration hook.

It does not turn cognition artifacts into kernel memory. Instead it:

- scans `.brewva/cognition/reference/` for prompt-relevant artifacts
- wraps selected artifacts as evidence-backed `context_packet` proposals
- relies on kernel receipts before those artifacts become visible as
  `brewva.context-packets`

Telemetry:

- `cognition_reference_rehydrated`
- `cognition_reference_rehydration_failed`

## Runtime Integration Contract

Extensions consume runtime domain APIs (for example `runtime.context.*`, `runtime.events.*`, `runtime.tools.*`) instead of legacy flat runtime methods.

Key implications:

- context injection path is async-first (`runtime.context.buildInjection(...)`)
- context pressure/compaction gate checks are delegated to `runtime.context.*`
- event writes/queries/subscriptions are delegated to `runtime.events.*`
- tool policy decisions are delegated to `runtime.tools.*`

## Context Transform Notes

`registerContextTransform` runs on `before_agent_start` and:

- appends a system-level context contract block
- injects a capability view block for progressive disclosure (compact tool list; expand with `$name`)
- injects runtime-built context via async injection path
- enforces compaction gate behavior under critical context pressure
- projects proposal-derived selection telemetry (`skill_routing_selection`)

CLI and gateway session bootstrap prepend `createSkillBrokerExtension` before the runtime extension stack.
That broker:

- reads `.brewva/skills_index.json`
- reranks the shortlist against candidate skill previews (`Intent` / `Trigger` / boundary sections)
- optionally runs a control-plane `pi-ai complete()` judge over the shortlist or full catalog candidate set before selecting
- writes control-plane traces under `.brewva/skill-broker/<sessionId>/`
- submits `skill_selection` and `skill_chain_intent` proposals through
  `@brewva/brewva-deliberation` helpers, which then cross the kernel boundary
  through `runtime.proposals.submit(...)` before `registerContextTransform` runs

This broker path is an optional control-plane assist layer. Runtime kernel
selection remains outside the kernel, so kernel governance semantics stay
deterministic and replayable.

Default context injection sources are:

- `brewva.identity`
- `brewva.truth-static`
- `brewva.truth-facts`
- `brewva.skill-candidates`
- `brewva.skill-dispatch-gate`
- `brewva.skill-cascade-gate`
- `brewva.context-packets`
  - packets are scoped by `scopeId`, collapse by latest `packetKey`, and stop
    injecting after `expiresAt`
- `brewva.task-state`
- `brewva.tool-failures`
- `brewva.tool-outputs-distilled`
- `brewva.projection-working`

## Runtime Core Bridge (`--no-extensions`)

`createRuntimeCoreBridgeExtension` / `registerRuntimeCoreBridge` provide a reduced extension surface when full extensions are disabled.

Retained hooks in this profile:

- `tool_call` (`registerQualityGate`) for runtime policy + compaction gate checks
- `tool_result` / `tool_execution_*` ledger persistence (`registerLedgerWriter`)
- `before_agent_start` core context block (`[CoreTapeStatus]` + autonomy contract + runtime context injection result)
- `session_compact` / `session_shutdown` lifecycle bookkeeping

Disabled full-extension hooks in this profile:

- `registerContextTransform` (`turn_start`, `context`, governance context lifecycle)
- `registerCompletionGuard`
- `registerEventStream`
- `registerNotification`

This means no-extensions keeps core safety/evidence guarantees, but omits presentation-oriented lifecycle orchestration from the full extension stack.

## Channel Bridge Notes

Channel bridge helpers (`createRuntimeChannelTurnBridge`, `createRuntimeTelegramChannelBridge`) consume channel contracts from `@brewva/brewva-runtime/channels`, not runtime root exports.
