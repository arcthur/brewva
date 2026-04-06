# Reference: Runtime Contract

Primary implementation anchor: `packages/brewva-runtime/src/runtime.ts`.

Related boundary references:

- `docs/architecture/design-axioms.md`
- `docs/reference/proposal-boundary.md`

## Role

`BrewvaRuntime` is the stable runtime instance contract for hosted sessions,
tools, and operator products.

It is intentionally organized around semantic root surfaces:

- `authority`
- `inspect`
- `maintain`

It is no longer organized as a wide top-level implementation bag.

The goal is not to hide runtime machinery. The goal is to make the default
coupling surface match the actual authority boundary.

Short version:

`public width is not authority width`

## Stable Root Shape

```ts
interface BrewvaRuntime {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
  readonly config: DeepReadonly<BrewvaConfig>;
  readonly authority: BrewvaAuthorityPort;
  readonly inspect: BrewvaInspectionPort;
  readonly maintain: BrewvaMaintenancePort;
}
```

Identity fields are read-only runtime facts:

- `cwd`
- `workspaceRoot`
- `agentId`
- `config`

`config` is a deep-readonly snapshot after normalization.

## Surface Rules

Interpret every public runtime method through these rules:

1. Surface tiers apply at the method or method-group level.
   A conceptual area such as scheduling or context may contribute methods to
   more than one surface.
2. `authority` is the commitment-facing surface.
   If an API changes replay truth, effect authorization, admission state,
   rollback identity, or verification sufficiency, it belongs here.
3. `inspect` is read-only.
   If an API writes tape, mutates session state, mutates runtime-owned
   registries, or changes admission state, it is not `inspect`.
4. `maintain` is explicit rebuild and bounded-recovery machinery.
   It may mutate working state, registration state, or recovery state, but it
   does not replace authority contracts.
5. Raw durability mechanisms are not the default product vocabulary.
   Prefer a narrower authority call or read model when one exists.

## `authority`

`authority` owns actions that change commitments, replay truth, admission
state, or rollback identity.

### `authority.skills`

- `activate(sessionId, name)`
- `complete(sessionId, output, options?)`

### `authority.proposals`

- `submit(sessionId, proposal)`
- `decideEffectCommitment(sessionId, requestId, input)`

This is the proposal / approval authority surface. Inspection of proposal state
lives under `inspect.proposals`. The stable proposal boundary is described in
`docs/reference/proposal-boundary.md`.

### `authority.tools`

- `start(input)`
- `finish(input)`
- `acquireParallelSlot(sessionId, runId)`
- `acquireParallelSlotAsync(sessionId, runId, options?)`
- `releaseParallelSlot(sessionId, runId)`
- `requestResourceLease(sessionId, request)`
- `cancelResourceLease(sessionId, leaseId, reason?)`
- `markCall(sessionId, toolName)`
- `trackCallStart(input)`
- `trackCallEnd(input)`
- `rollbackLastPatchSet(sessionId)`
- `rollbackLastMutation(sessionId)`
- `recordResult(input)`

`authority.tools.start(...)` remains the shared authorization spine:

- boundary classification
- governance resolution
- approval-bearing exact resume
- mutation receipt creation

Raw tape append is not part of this public tool authority surface.

### `authority.task`

- `setSpec(sessionId, spec)`
- `addItem(sessionId, input)`
- `updateItem(sessionId, input)`
- `recordBlocker(sessionId, input)`
- `recordAcceptance(sessionId, input)`
- `resolveBlocker(sessionId, blockerId)`

### `authority.truth`

- `upsertFact(sessionId, input)`
- `resolveFact(sessionId, truthFactId)`

### `authority.schedule`

- `createIntent(sessionId, input)`
- `cancelIntent(sessionId, input)`
- `updateIntent(sessionId, input)`

### `authority.events`

These are typed authority-side evidence writes, not a general event append API:

- `recordMetricObservation(sessionId, input)`
- `recordGuardResult(sessionId, input)`
- `recordTapeHandoff(sessionId, input)`

### `authority.verification`

`verification` remains an authority surface.

The current public methods are:

- `evaluate(sessionId, level?)`
- `verify(sessionId, level?, options?)`

Verification semantics to preserve:

- default verification checks are expanded per target root
- command-backed checks only become authoritative after `brewva_verify`
- missing fresh verification evidence and actual check failures stay distinct; they are not collapsed into one debt state
- ordinary verifier blockers are verification debt, not automatic hard blockers

### `authority.cost`

- `recordAssistantUsage(sessionId, input)`

### `authority.session`

- `applyMergedWorkerResults(sessionId, report)`

## `inspect`

`inspect` is the read-only operator and host read-model surface.

### `inspect.skills`

- `getLoadReport()`
- `list()`
- `get(name)`
- `getActive(sessionId)`
- `validateOutputs(sessionId, outputs)`
- `getOutputs(sessionId, skillName)`
- `getConsumedOutputs(sessionId, targetSkillName)`

### `inspect.proposals`

- `list(sessionId, query?)`
- `listEffectCommitmentRequests(sessionId, query?)`
- `listPendingEffectCommitments(sessionId)`

### `inspect.context`

- `sanitizeInput(text)`
- `getUsage(sessionId)`
- `getUsageRatio(usage)`
- `getHardLimitRatio(sessionId, usage?)`
- `getCompactionThresholdRatio(sessionId, usage?)`
- `getPressureStatus(sessionId, usage?)`
- `getPressureLevel(sessionId, usage?)`
- `getCompactionGateStatus(sessionId, usage?)`
- `checkCompactionGate(sessionId, toolName, usage?)`
- `listProviders()`
- `getPendingCompactionReason(sessionId)`
- `getCompactionInstructions()`
- `getCompactionWindowTurns()`

### `inspect.tools`

- `checkAccess(sessionId, toolName, args?)`
- `explainAccess(input)`
- `getGovernanceDescriptor(toolName, args?)`
- `listResourceLeases(sessionId, query?)`
- `resolveUndoSessionId(preferredSessionId?)`

### `inspect.task`

- `getTargetDescriptor(sessionId)`
- `getState(sessionId)`

### `inspect.truth`

- `getState(sessionId)`

### `inspect.ledger`

- `getDigest(sessionId)`
- `query(sessionId, query)`
- `listRows(sessionId?)`
- `verifyIntegrity(sessionId)`
- `getPath()`

### `inspect.schedule`

- `listIntents(query?)`
- `getProjectionSnapshot()`

### `inspect.recovery`

- `listPending()`

This is the public read model for pending WAL-backed recovery state.
Mutation of WAL rows is not part of the public runtime contract.

### `inspect.events`

- `query(sessionId, query?)`
- `queryStructured(sessionId, query?)`
- `listMetricObservations(sessionId, query?)`
- `listGuardResults(sessionId, query?)`
- `getTapeStatus(sessionId)`
- `getTapePressureThresholds()`
- `searchTape(sessionId, query, scope?)`
- `listReplaySessions()`
- `subscribe(listener)`
- `toStructured(event)`
- `list(sessionId, query?)`
- `listSessionIds()`

`inspect.events` does not expose raw event append.

`inspect.events` is the raw tape inspection surface. It is intentionally wider
than the frontend/session transport contract.

### `inspect.cost`

- `getSummary(sessionId)`

### `inspect.session`

- `listWorkerResults(sessionId, query?)`
- `mergeWorkerResults(sessionId, query?)`
- `getHydration(sessionId)`
- `getIntegrity(sessionId)`

### `inspect.sessionWire`

- `query(sessionId)`
- `subscribe(sessionId, listener)`

`inspect.sessionWire` is the stable derived session read model for frontend and
gateway consumers. It compiles a narrow replay-first event protocol from
durable tape receipts such as `turn_input_recorded`,
`turn_render_committed`, `session_turn_transition`,
approval receipts, subagent lifecycle receipts, and `session_shutdown`.

This surface does not replace `inspect.events`. The tape remains the durable
source of truth; `inspect.sessionWire` is the versioned projection that
frontends and transports consume.

This surface is keyed by runtime session ids. Gateway public-session replay is
one layer higher: gateway first resolves public session ids through durable
`gateway_session_bound` control-tape receipts, then applies the same
runtime-owned compiler semantics to the underlying agent-session tapes.

This is an experience-ring read model, not a new authority surface. Live cache
augmentation such as `assistant.delta`, `tool.progress`, and `session.status`
belongs at the gateway transport edge and remains outside the durable compiler.
In the current wire, live `tool.started`, `tool.progress`, and `tool.finished`
are explicitly attempt-scoped through repo-owned lifecycle binding; replay still
converges only through committed `turn.committed.toolOutputs`.

## `maintain`

`maintain` is the explicit rebuild and bounded-recovery surface.

### `maintain.skills`

- `refresh(input?)`

This is the explicit skill-registry rebuild path.

### `maintain.context`

- `onTurnStart(sessionId, turnIndex)`
- `onTurnEnd(sessionId)`
- `onUserInput(sessionId)`
- `observeUsage(sessionId, usage)`
- `registerProvider(provider)`
- `unregisterProvider(source)`
- `buildInjection(sessionId, prompt, usage?, injectionScopeId?, sourceAllowlist?)`
- `appendSupplementalInjection(sessionId, inputText, usage?, injectionScopeId?)`
- `checkAndRequestCompaction(sessionId, usage)`
- `requestCompaction(sessionId, reason)`
- `markCompacted(sessionId, input)`

This surface owns deterministic context admission and explicit compaction
maintenance. It does not authorize effects.

### `maintain.tools`

- `registerGovernanceDescriptor(toolName, input)`
- `registerGovernanceResolver(toolName, resolver)`
- `unregisterGovernanceDescriptor(toolName)`

These are maintenance-time governance registry operations. They are not
read-only inspection and they are not effect authority by themselves.

### `maintain.session`

- `recordWorkerResult(sessionId, input)`
- `clearWorkerResults(sessionId)`
- `pollStall(sessionId, input?)`
- `clearState(sessionId)`
- `onClearState(listener)`
- `resolveCredentialBindings(sessionId, toolName)`
- `resolveSandboxApiKey(sessionId)`

### `maintain.recovery`

- `recover()`
- `compact()`

This is the public recovery-maintenance surface.

## Caller-Specific Ports

The stable runtime package also exposes narrower role ports.

### `BrewvaHostedRuntimePort`

Hosted runtime consumers receive the full semantic surface:

- identity fields
- `authority`
- `inspect`
- `maintain`

This is the default lifecycle-facing runtime view for hosted pipeline wiring.

### `BrewvaToolRuntimePort`

Tool consumers receive:

- identity fields
- `authority`
- `inspect`

They do not receive `maintain` by default.

This is the stable public minimum for tool-facing runtime access.

Repo-owned bundled tools that need runtime-owned telemetry, credential
resolution, supplemental injection, or similar implementation-side hooks do not
rediscover a raw `BrewvaRuntime`. Instead, `@brewva/brewva-tools` composes this
semantic port with explicit injected `internal` hooks to form
`BrewvaBundledToolRuntime`.

### `BrewvaOperatorRuntimePort`

Operator products receive:

- identity fields
- full `inspect`
- limited `maintain`
  - `maintain.session`
  - `maintain.recovery`

This keeps inspection rich while narrowing mutation authority.

Embedded operator commands such as `/inspect` and `/insights` are built against
this port rather than against the full hosted runtime surface.

## Internal Subpath

Some capabilities remain explicit for repo-owned implementation wiring, but
they are intentionally outside the stable root runtime contract.

Use `@brewva/brewva-runtime/internal` only when repository-owned code genuinely
needs raw ingress or raw append semantics.

Stable docs may name this subpath to explain repository wiring boundaries. That
does not make it a default product integration surface.

Examples:

- `createSchedulerIngressPort(runtime)` for scheduler / channel WAL ingress
- `RecoveryWalStore` / `RecoveryWalRecovery` for repo-owned Recovery WAL machinery
- `createRuntimeInternalEventAppendPort(runtime)` for raw event append ports
- `recordRuntimeEvent(runtime, input)` for repo-owned tape append wiring

Raw event append is available only as an internal subpath capability, not as a
product-level runtime surface.

## Export Policy

`@brewva/brewva-runtime` root exports:

- stable contracts
- `BrewvaRuntime`
- semantic port types
- caller-port constructors
- governance helpers
- stable event and artifact vocabularies

Repo-owned implementation escape hatches live under:

- `@brewva/brewva-runtime/internal`

Examples:

- scheduler service
- event store
- replay engine
- patch-history helpers
- credential-vault service
- context arena / collector / budget managers

`internal` is for repository-owned implementation coupling. It is not part of
the stable product contract described by this reference.

## Durability Reading

The semantic surfaces above sit on top of the repository durability taxonomy:

- `durable source of truth`
  - tape, receipts, task/truth/schedule commitment events
- `durable transient`
  - Recovery WAL and rollback material
- `rebuildable state`
  - projection and other derived inspection products
- `cache`
  - host or UX helper state outside replay correctness

This taxonomy explains why:

- `authority` must remain narrow and replay-first
- `inspect` can stay rich without becoming authority
- `maintain` can stay explicit without becoming the default product language
