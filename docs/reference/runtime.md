# Reference: Runtime API

Primary class: `packages/brewva-runtime/src/runtime.ts`.

## Runtime Role

`BrewvaRuntime` is the public facade for runtime governance. Internally,
execution is delegated to services under `packages/brewva-runtime/src/services/`
and replay/state folding is handled by `TurnReplayEngine`.

## Durability Posture

`BrewvaRuntime` exposes both authoritative replay surfaces and derived working
views.

The public runtime follows the repository durability taxonomy:

- `durable source of truth`
  - event tape, checkpoints, task/truth/schedule intent events, proposal
    receipts, approval events, and linked tool outcomes
- `durable transient`
  - `runtime.turnWal.*` crash-recovery state and rollback patch/snapshot
    material used by undo
- `rebuildable state`
  - working projection, `workflow_status`, and other explicit inspection views
    rebuilt from durable truth plus workspace state
- `cache`
  - host or channel helper state outside the runtime replay contract

The runtime never requires channel helper state or projection cache files to
reconstruct commitment history or approval truth after restart.

Public access is organized into domain APIs. Alongside those domains, runtime
exposes read-only identity and environment state:

- `cwd`
- `workspaceRoot`
- `agentId`
- `config`

`runtime.config` is a deep-readonly snapshot after construction.

## Public Surface (Domain APIs)

### `runtime.skills.*`

- `refresh()`
- `getLoadReport()`
- `list()`
- `get(name)`
- `activate(sessionId, name)`
- `getActive(sessionId)`
- `validateOutputs(sessionId, outputs)`
- `complete(sessionId, output)`
- `getOutputs(sessionId, skillName)`
- `getConsumedOutputs(sessionId, targetSkillName)`

### `runtime.proposals.*`

- `submit(sessionId, proposal)`
- `list(sessionId, query?)`
- `listEffectCommitmentRequests(sessionId, query?)`
- `listPendingEffectCommitments(sessionId)`
- `decideEffectCommitment(sessionId, requestId, input)`

Proposal boundary semantics:

- proposal admission is effect-commitment-only
- `list(sessionId, query?)` returns `EffectCommitmentRecord[]` newest first by receipt
  timestamp
- approval-bearing requests are replay-hydrated from tape after restart
- `listEffectCommitmentRequests(sessionId, query?)` returns request-scoped approval
  state, including `accepted` requests that are not yet consumed
- accepted approval does not auto-apply to later matching calls; the caller
  must resume the exact approved request through `runtime.tools.start(...)` with
  the original `toolCallId` and canonical argument identity

Reference: `docs/reference/proposal-boundary.md`.

### `runtime.context.*`

- `onUserInput(sessionId)`
- `onTurnStart(sessionId, turnIndex)`
- `onTurnEnd(sessionId)`
- `sanitizeInput(text)`
- `observeUsage(sessionId, usage)`
- `getUsage(sessionId)`
- `getUsageRatio(usage)`
- `getHardLimitRatio(sessionId, usage?)`
- `getCompactionThresholdRatio(sessionId, usage?)`
- `getPressureStatus(sessionId, usage?)`
- `getPressureLevel(sessionId, usage?)`
- `getCompactionGateStatus(sessionId, usage?)`
- `checkCompactionGate(sessionId, toolName, usage?)`
- `registerProvider(provider)`
- `unregisterProvider(source)`
- `listProviders()`
- `buildInjection(sessionId, prompt, usage?, injectionScopeId?)`
- `appendSupplementalInjection(sessionId, inputText, usage?, injectionScopeId?)`
- `checkAndRequestCompaction(sessionId, usage)`
- `requestCompaction(sessionId, reason)`
- `getPendingCompactionReason(sessionId)`
- `getCompactionInstructions()`
- `getCompactionWindowTurns()`
- `markCompacted(sessionId, input)`

`buildInjection(...)` returns admitted context entries after deterministic
budgeting, deduplication, and source governance. Runtime plugins may compose those
entries for the model, but they do not bypass kernel admission.

Lifecycle note:

- `onTurnStart(...)` initializes turn-local context budgeting state
- `onUserInput(...)` eagerly hydrates session-scoped runtime state for hosted
  input hooks
- `onTurnEnd(...)` clears pending turn-local injection reservations

Default runtime-owned injected sources:

- `brewva.identity`
- `brewva.agent-constitution`
- `brewva.agent-memory`
- `brewva.runtime-status`
- `brewva.task-state`
- `brewva.projection-working`
- `brewva.tool-outputs-distilled` (optional)

Hosted sessions additionally register these internal deliberation sources:

- `brewva.deliberation-memory`
- `brewva.optimization-continuity`
- `brewva.skill-promotion-drafts`

Naming note:

- agent-facing tool ids stay `snake_case` (for example `skill_promotion`)
- context source ids stay scoped dotted identifiers (for example
  `brewva.skill-promotion-drafts`)
- a source id may name the folded artifact more narrowly than the tool that
  inspects or advances it

These hosted sources fold existing evidence into reusable context, but they do
not become kernel authority. Runtime truth, task state, schedule events,
receipts, and turn durability remain the authoritative replay surfaces.

There is no default proposal-backed context source anymore. There is no default
injected workflow advisory or `workflow_status` context source.

### `runtime.tools.*`

- `checkAccess(sessionId, toolName)`
- `explainAccess(input)`
- `getGovernanceDescriptor(toolName)`
- `registerGovernanceDescriptor(toolName, input)`
- `unregisterGovernanceDescriptor(toolName)`
- `start(input)`
- `finish(input)`
- `recordResult(input)`
- `acquireParallelSlot(sessionId, runId)`
- `acquireParallelSlotAsync(sessionId, runId, options?)`
- `releaseParallelSlot(sessionId, runId)`
- `markCall(sessionId, toolName)`
- `trackCallStart(input)`
- `trackCallEnd(input)`
- `requestResourceLease(sessionId, request)`
- `listResourceLeases(sessionId, query?)`
- `cancelResourceLease(sessionId, leaseId, reason?)`
- `rollbackLastPatchSet(sessionId)`
- `rollbackLastMutation(sessionId)`
- `resolveUndoSessionId(preferredSessionId?)`

Tool semantics:

- `explainAccess(input)` accepts optional `args` and `cwd` so runtime can
  explain boundary-policy decisions for tools such as `exec` and
  `browser_open` without executing them
- `start(input)` accepts optional `effectCommitmentRequestId` when resuming an
  operator-approved effect commitment
- `start(input)` also accepts optional `cwd`; exact-call loop detection and
  boundary-policy evaluation run on the same shared invocation path before tool
  execution proceeds
- deferred approval-bearing starts return the same
  `effectCommitmentRequestId` on the result surface
- `finish(input)` and `recordResult(input)` use `channelSuccess` for transport
  success and `verdict` for semantic outcome
- durable linked tool results consume accepted approvals
- `rollbackLastPatchSet(sessionId)` is the runtime `PatchSet` rollback entrypoint
  behind the stable tool id `rollback_last_patch` and the CLI `--undo` flow

Tool-governance note:

- managed Brewva tools resolve exact governance descriptors first
- custom or third-party tools may register runtime-scoped exact descriptors
- regex hint fallback is advisory only; it can emit metadata warnings, but it
  does not authorize effectful execution or proposal admission
- effectful execution requires durable tape receipts; with
  `infrastructure.events.enabled=false`, effectful tools fail closed instead of
  running in a no-audit path
- `rollbackLastMutation(...)` is the receipt-aware rollback surface
  - only receipt-backed rollbackable mutations participate; audit-only
    `memory_write` flows do not imply a rollback anchor
  - durable `reversible_mutation_*` receipts are replay-hydrated, so restart
    does not remove the latest rollback candidate

### `runtime.task.*`

- `setSpec(sessionId, spec)`
- `addItem(sessionId, input)`
- `updateItem(sessionId, input)`
- `recordBlocker(sessionId, input)`
- `recordAcceptance(sessionId, input)`
- `resolveBlocker(sessionId, blockerId)`
- `getState(sessionId)`

Task closure semantics:

- verification remains evidence sufficiency
- acceptance is an explicit operator-visible closure layer
- non-verifier blockers, including governance-owned verifier blockers, are hard
  blockers and keep the task in `blocked`
- ordinary verifier blockers are verification debt, not execution erasure; if
  task items remain open the task stays in `execute`, and it moves to `verify`
  only after execute items are complete
- when `TaskSpec.acceptance.required === true`, a verification pass moves the
  task to `ready_for_acceptance`
- only recorded acceptance moves the task to `done`
- acceptance writes are non-rollbackable closure records rather than reversible
  task-state edits

### `runtime.truth.*`

- `getState(sessionId)`
- `upsertFact(sessionId, input)`
- `resolveFact(sessionId, truthFactId)`

### `runtime.ledger.*`

- `getDigest(sessionId)`
- `query(sessionId, query)`
- `listRows(sessionId?)`
- `verifyIntegrity(sessionId)`
- `getPath()`

Ledger note:

- evidence rows are durable evidence material, but `verifyIntegrity(...)`
  validates local row coherence, not anti-tamper or distributed-security
  guarantees

### `runtime.schedule.*`

- `createIntent(sessionId, input)`
- `cancelIntent(sessionId, input)`
- `updateIntent(sessionId, input)`
- `listIntents(query?)`
- `getProjectionSnapshot()`

Schedule note:

- schedule intent events remain the authoritative replay surface
- `getProjectionSnapshot()` is a rebuildable derived view rather than a
  correctness prerequisite

### `runtime.turnWal.*`

- `appendPending(envelope, source, options?)`
- `markInflight(walId)`
- `markDone(walId)`
- `markFailed(walId, error?)`
- `markExpired(walId)`
- `listPending()`
- `recover()`
- `compact()`

### `runtime.events.*`

- `record(input)`
- `query(sessionId, query?)`
- `queryStructured(sessionId, query?)`
- `recordMetricObservation(sessionId, input)`
- `listMetricObservations(sessionId, query?)`
- `recordGuardResult(sessionId, input)`
- `listGuardResults(sessionId, query?)`
- `getTapeStatus(sessionId)`
- `getTapePressureThresholds()`
- `recordTapeHandoff(sessionId, input)`
- `searchTape(sessionId, input)`
- `listReplaySessions(limit?)`
- `subscribe(listener)`
- `toStructured(event)`
- `list(sessionId, query?)`
- `listSessionIds()`

Hosted-session event boundary notes:

- `runtime.events.query(...)` and `runtime.events.queryStructured(...)` expose
  the durable tape, not the ephemeral hosted live stream
- iteration fact helpers persist and query receipt-grade objective facts:
  metric observations and guard results
- iteration fact list helpers accept optional `source` and `sessionScope`
  filters; the stable runtime contract only supports
  `sessionScope=current_session`
- live-only hosted events such as `message_update` and `tool_execution_update`
  are intentionally not replay-visible through the runtime event API
- hosted sessions do not expose a separate provider-normalization event family;
  durable replay surfaces start at admitted runtime events such as `tool_call`,
  `tool_result_recorded`, and related governance receipts

### `runtime.verification.*`

- `evaluate(sessionId, level?)`
- `verify(sessionId, level?, options?)`

Read-only verification semantics:

- `evaluate(...)` / `verify(...)` return `report.readOnly=true`,
  `report.skipped=true`, `report.reason="read_only"` when no write was
  observed in session
- skipped read-only evaluation records `outcome="skipped"` rather than `pass`
- verification evidence is replayed from tape via
  `verification_write_marked` and `tool_result_recorded.verificationProjection`
- default verification checks are expanded per target root for the active task;
  multi-root tasks therefore record separate check identities and check-run
  provenance per root
- auto-discovered package verification scripts execute through the root package
  manager command (`bun run`, `pnpm run`, `yarn`, or `npm run`) rather than the
  raw script body
- command-backed checks are tracked as `command_passed` evidence and replay into
  root-scoped `checkRuns`; verification freshness is judged against the most
  recent `verification_write_marked` boundary

### `runtime.cost.*`

- `recordAssistantUsage(input)`
- `getSummary(sessionId)`

### `runtime.session.*`

- `recordWorkerResult(sessionId, result)`
- `listWorkerResults(sessionId)`
- `mergeWorkerResults(sessionId)`
- `applyMergedWorkerResults(sessionId, input)`
- `clearWorkerResults(sessionId)`
- `pollStall(sessionId, input?)`
- `clearState(sessionId)`
- `onClearState(listener)`
- `getHydration(sessionId)`
- `getIntegrity(sessionId)`
- `resolveCredentialBindings(sessionId, toolName)`
- `resolveSandboxApiKey(sessionId)`

Delegation taxonomy:

- `subagent_*` is the model/operator-facing tool family for starting,
  inspecting, and cancelling delegated child runs
- `DelegationRunRecord` is owned by the hosted control-plane read model, not by
  `runtime.session.*`
- `WorkerResult` is a child-produced patch/adoption artifact for patch-producing
  delegated runs; it is not the delegated run record itself

Worker-result adoption semantics:

- `mergeWorkerResults(...)` is read-only and reports `empty | conflicts | merged`
- `applyMergedWorkerResults(...)` mutates the parent workspace only after the
  parent explicitly adopts the merged result

Session durability semantics:

- `getHydration(...)` reports replay hydration status for session-local state
  rebuild
- `getIntegrity(...)` reports the unified durability health surface across
  session tape issues, runtime WAL integrity failures, and artifact persistence
  gaps
- integrity issues carry explicit `domain` / `severity` metadata instead of
  overloading hydration-only issue shapes

Execution-secret semantics:

- `resolveCredentialBindings(...)` returns the env var map resolved from
  `security.credentials.bindings` for the requested tool
- `resolveSandboxApiKey(...)` resolves the configured sandbox API key ref from
  the encrypted credential vault
- these helpers are execution-layer surfaces for trusted host/runtime adapters;
  they are not a model-facing secret read API

Delegation inspection semantics:

- hosted delegation status and pending handoff inspection are provided by the
  gateway control-plane read model
- pending delegation outcomes remain explicit inspection state; they do not
  auto-inject patches, auto-complete skills, or widen child authority

## Execution Model

Public effect vocabulary is:

- `safe`
- `effectful`

Runtime still distinguishes three internal realities:

- `safe`
- `effectful` and rollbackable
- `effectful` and approval-bound

The public API stays smaller than the internal machinery:

- capability disclosure talks about boundary, approval, and rollbackability
- rollback receipts stay durable
- approval requests stay replayable

There are no public runtime plugin profiles such as `memory` or `full`.
