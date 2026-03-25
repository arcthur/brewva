# Reference: Runtime API

Primary class: `packages/brewva-runtime/src/runtime.ts`.

## Runtime Role

`BrewvaRuntime` is the public facade for runtime governance. Internally,
execution is delegated to services under `packages/brewva-runtime/src/services/`
and replay/state folding is handled by `TurnReplayEngine`.

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
- `listPendingEffectCommitments(sessionId)`
- `decideEffectCommitment(sessionId, requestId, input)`

Proposal boundary semantics:

- the public proposal kind is now only `effect_commitment`
- `list(sessionId, query?)` returns `ProposalRecord[]` newest first by receipt
  timestamp
- approval-bearing requests are replay-hydrated from tape after restart
- accepted approval does not auto-apply to later matching calls; the caller
  must resume the exact pending request through `runtime.tools.start(...)`

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
budgeting, deduplication, and source governance. Extensions may compose those
entries for the model, but they do not bypass kernel admission.

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

- `start(input)` accepts optional `effectCommitmentRequestId` when resuming an
  operator-approved effect commitment
- deferred approval-bearing starts return the same
  `effectCommitmentRequestId` on the result surface
- `finish(input)` and `recordResult(input)` use `channelSuccess` for transport
  success and `verdict` for semantic outcome
- durable linked tool results consume accepted approvals

Tool-governance note:

- managed Brewva tools resolve exact governance descriptors first
- custom or third-party tools may register runtime-scoped exact descriptors
- regex hint fallback remains available as a migration path
- `rollbackLastMutation(...)` is the receipt-aware rollback surface

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
- `verifyChain(sessionId)`
- `getPath()`

### `runtime.schedule.*`

- `createIntent(sessionId, input)`
- `cancelIntent(sessionId, input)`
- `updateIntent(sessionId, input)`
- `listIntents(query?)`
- `getProjectionSnapshot()`

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
  filters; `sessionScope=parent_lineage` resolves the owning parent session
  plus scheduler-created `continuityMode=inherit` child sessions while keeping
  each record's true `sessionId`
- live-only hosted events such as `message_update` and `tool_execution_update`
  are intentionally not replay-visible through the runtime event API
- pre-parse compatibility evidence surfaces through durable ops telemetry such
  as `tool_call_normalized` and `tool_call_normalization_failed` when
  `infrastructure.events.level >= ops`
- model capability selection and request patch telemetry are emitted by the
  hosted gateway adapter, not by the runtime kernel itself

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
- `recordDelegationRun(sessionId, record)`
- `getDelegationRun(sessionId, runId)`
- `listDelegationRuns(sessionId, query?)`
- `listPendingDelegationOutcomes(sessionId, query?)`
- `clearState(sessionId)`
- `onClearState(listener)`
- `getHydration(sessionId)`

Worker-result adoption semantics:

- `mergeWorkerResults(...)` is read-only and reports `empty | conflicts | merged`
- `applyMergedWorkerResults(...)` mutates the parent workspace only after the
  parent explicitly adopts the merged result

Delegation session semantics:

- `listDelegationRuns(...)` exposes the full replay-hydrated child run ledger
- `listPendingDelegationOutcomes(...)` is the stable derived handoff view for
  late background outcomes that still await a parent turn
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

There are no public extension profiles such as `memory` or `full`.
