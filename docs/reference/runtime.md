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

Runtime boundary note:

- `BrewvaRuntime` is the semantic authority/inspect/maintain contract
- the hosted/CLI/channel session loop lives in the substrate and host layers,
  not in the runtime root object
- prompt expansion, session persistence, and turn orchestration are substrate
  concerns that consume runtime authority rather than widening the runtime
  surface back into a mixed session-manager API
- Pi compatibility remains import/export oriented and does not justify
  reintroducing runtime-path dependency on `Pi`

## Current Transaction Boundary

The current stable authority-bearing transaction boundary is
`single tool-call granularity`.

Runtime guarantees durable semantics for one tool call at a time:

- classify the call
- authorize, defer, or deny it
- resume exact approval-bearing calls by request id and digest
- record durable linked outcomes
- roll back the latest mutation or patch set when the effect model supports a
  rollback receipt

The runtime does not currently expose a stable public contract for cross-agent
saga semantics, generalized compensation graphs, or broader all-or-nothing
control-plane transactions. Hosted orchestration, scheduler triggers, and
delegated runs remain control-plane behavior over kernel receipts rather than a
second transaction kernel.

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
- `recordCompletionFailure(sessionId, outputs, validation, usage?)`
- `complete(sessionId, output, options?)`

`complete(...)` remains the authoritative skill commit boundary. It re-runs the
same closed validation composition exposed through
`inspect.skills.validateOutputs(...)`, but rebuilds validation context from the
latest post-verification evidence before recording `skill_completed`. Both
`validateOutputs(...)` and `complete(...)` fail closed when no active skill is
loaded for the target session.

Stable producer-boundary rule:

- `skill_completed` stores the raw producer payload as durable evidence
- authored non-semantic `outputContracts` and Tier A blockers may still reject
  completion
- semantic-bound normalization drift is carried forward as inspectable
  normalized state unless a declared blocking consumer requires exactness at the
  current boundary

Current implementation note:

- completion semantics are driven by the validated `outputs` payload
- although the public type still accepts an optional completion annotation
  object, the current runtime-owned completion fold does not persist or inspect
  those extra fields when committing `skill_completed`

### `authority.proposals`

- `submit(sessionId, proposal)`
- `decideEffectCommitment(sessionId, requestId, input)`

This is the proposal / approval authority surface. Inspection of proposal state
lives under `inspect.proposals`. The stable proposal boundary is described in
`docs/reference/proposal-boundary.md`. Raw receipt chronology remains on
`inspect.events`; this surface is the authority entrypoint, not the event
catalog.

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

### `authority.reasoning`

- `recordCheckpoint(sessionId, input)`
- `revert(sessionId, input)`

This is the kernel-owned reasoning-branch authority surface.

Stable rules:

- `reasoning_checkpoint` and `reasoning_revert` are append-only branch
  receipts, not hosted-only prompt rewrites
- checkpoint boundaries are explicit and finite:
  `turn_start`, `tool_boundary`, `verification_boundary`,
  `compaction_boundary`, and `operator_marker`
- checkpoint ids are never reused within a session; branch ids are
  kernel-assigned and monotonic per session, with a deterministic root branch
- `revert(...)` may move the active reasoning lineage to an earlier checkpoint,
  but it does not roll back files, reset cost truth, or erase evidence truth
- continuity packets are normalized to
  `brewva.reasoning.continuity.v1` and rejected when the UTF-8 payload exceeds
  `1200` bytes
- filesystem undo remains receipt-based under `authority.tools.rollback*`
- `model_self_repair` remains a narrow control-plane path; it does not create a
  hidden planner-owned history rewrite lane
- public `reasoning_revert` calls that omit `trigger` are recorded as
  `operator_request`; `model_self_repair` must be explicit in the durable
  receipt

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

- `recordAssistantUsage(input)`

### `authority.session`

- `commitCompaction(sessionId, input)`
- `applyMergedWorkerResults(sessionId, { toolName, toolCallId? })`

`applyMergedWorkerResults(...)` does not accept an arbitrary merged patch report
from the caller. The runtime recomputes merge state from the session's recorded
`WorkerResult` artifacts, then records the parent-controlled adoption outcome.

## `inspect`

`inspect` is the read-only operator and host read-model surface.

Slash-command syntax such as `/models`, `/connect`, `/think`, `/inspect`,
`/insights`, `/questions`, and `/answer` is documented in
`docs/reference/commands.md`. This page defines the underlying replay-first
contracts those operator products read from. `/questions` is the operator inbox
view over pending input requests and follow-up questions, not a separate
runtime state machine.

### `inspect.skills`

- `getLoadReport()`
- `list()`
- `get(name)`
- `getActive(sessionId)`
- `getActiveState(sessionId)`
- `getLatestFailure(sessionId)`
- `validateOutputs(sessionId, outputs)`
- `getRawOutputs(sessionId, skillName)`
- `getNormalizedOutputs(sessionId, skillName)`
- `getConsumedOutputs(sessionId, targetSkillName)`

`validateOutputs(...)` is the preview surface for the same runtime-owned
validator composition used by `authority.skills.complete(...)`. It does not
cache commit decisions or transfer caller-owned validation state across the
verification boundary, and it requires an active skill.

`getRawOutputs(...)` returns the durable producer payload recorded by
`skill_completed`. `getNormalizedOutputs(...)` returns the runtime-owned
normalized consumer view with canonical data, field-level issues, blocking
state, provenance, and the normalizer version used to derive it.

Semantic schema ids such as `planning.execution_plan.v2` name this normalized
consumer-facing view. They do not imply that the producer had to emit the same
canonical shape at completion time.

`getConsumedOutputs(...)` returns the normalized consumer-facing aggregate for a
target skill, not the raw upstream output map. Operator and host surfaces
should distinguish raw presence from normalized availability and partial or
blocking states.

### `inspect.proposals`

- `list(sessionId, query?)`
- `listEffectCommitmentRequests(sessionId, query?)`
- `listPendingEffectCommitments(sessionId)`

This is the normalized replay-first read model for proposal and approval
status. For raw receipt chronology and payload inspection, use
`inspect.events` together with `docs/reference/events.md`.

Ordering semantics:

- `list(sessionId, query?)` returns newest-first `EffectCommitmentRecord`
  values by receipt timestamp
- `listEffectCommitmentRequests(sessionId, query?)` returns newest-first
  request-state rows by `updatedAt`
- `listPendingEffectCommitments(sessionId)` is the pending-only queue ordered
  by request `createdAt`

### `inspect.context`

- `sanitizeInput(text)`
- `getUsage(sessionId)`
- `getPromptStability(sessionId)`
- `getHistoryViewBaseline(sessionId)`
- `getTransientReduction(sessionId)`
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

`getPromptStability(...)` and `getTransientReduction(...)` are live
session-local inspection surfaces. They are cleared with normal session-state
teardown and do not imply new durable event families. Hosted longitudinal
evidence for these fields lives in the sidecar context-evidence store under
`.orchestrator/context-evidence`; operators can aggregate it with
`bun run report:context-evidence`. Prompt-stability is scope-aware: the first
sample in a new hosted leaf or injection scope seeds a fresh stable-prefix
baseline, while `stableTail` still requires the same scope key plus the same
tail hash.

`getHistoryViewBaseline(...)` is the read model for the current
model-visible baseline. When a compatible `session_compact` receipt exists, it
returns that leaf-scoped rewrite baseline; otherwise it can fall back to a
bounded `exact_history` snapshot derived from replay-visible
`turn_input_recorded` / `turn_render_committed` receipts.
It therefore does not guarantee full transcript equivalence, and it does not
include task state, tool lifecycle hints, or recovery instructions.

The returned snapshot carries `rebuildSource = receipt | cache | exact_history`.
`exact_history` is continuity fallback rather than replacement authority: it is
bounded to recent turns and can disappear into recovery
`diagnostic_only` posture when branch lineage is ambiguous or the baseline
budget is exceeded.

This inspect surface is intentionally richer than the model-facing baseline
block. `docs/reference/context-composer.md` covers how the rewrite text is
rendered for the model, while `docs/reference/working-projection.md` covers the
separate rebuildable working snapshot that may appear alongside it.

`listProviders()` is the runtime-owned primary-source descriptor surface.

Each descriptor carries the current execution contract for one
`primary_registry` source:

- `source`
- `plane`
- `admissionLane`
- `category`
- `budgetClass`
- `collectionOrder`
- `selectionPriority`
- `readsFrom`
- `continuityCritical`
- `profileSelectable`
- `preservationPolicy`
- optional `reservedBudgetRatio`

This surface is the metadata truth for primary context providers. Hosted
`contextProfile` narrowing, inspect tooling, and contract tests should derive
from these descriptors rather than from duplicated static tables or hand-kept
source lists.

Provider authoring must go through `defineContextSourceProvider(...)`. The
constructor chooses the legal plane / authority / budget / preservation matrix
for each source kind, and the registry rejects unconstructed providers plus
spoofed illegal combinations before they can affect hosted prompt behavior.
Construction also rejects malformed source ids, non-integer ordering metadata,
untrimmed read dependencies, and non-function collectors.
Directly hand-authoring a `ContextSourceProvider` descriptor is not a supported
extension path.

The descriptor surface is not a general policy-extension point. When a provider
family requires a fixed plane / budget / authority / preservation combination,
prefer source-kind construction helpers, registry validation, and contract tests
over asking maintainers to remember the combination from RFC prose. Avoid adding
descriptor fields or hosted profile modes unless the same change removes an
older convention or converts a documentation-only invariant into enforcement.

`reservedBudgetRatio` is provider-admission metadata. Runtime-owned recovery
inspection, including history-view baseline reconstruction, uses its own
kernel constant rather than dynamically deriving the reserved budget from the
mutable provider registry.

### `inspect.tools`

- `checkAccess(sessionId, toolName, args?)`
- `explainAccess(input)`
- `getActionPolicy(toolName, args?)`
- `listResourceLeases(sessionId, query?)`
- `resolveUndoSessionId(preferredSessionId?)`

For `exec`, `explainAccess(input)` also returns `commandPolicy` when
`input.args.command` is present. This explanation shows why the command is
read-only eligible, effectful, unsupported, or blocked by deployment boundary
rules without executing the command.

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

`inspect.schedule` is the read model over rebuildable schedule projection state.

- `listIntents(query?)` filters by `parentSessionId?` and `status?`
  (`active | cancelled | converged | error`) and returns projected intent
  records ordered by `updatedAt` descending, then `intentId`
- `getProjectionSnapshot()` returns the current schedule projection snapshot
  after recovery has rebuilt scheduler state from schedule events. Its shape is
  (`schema`, `generatedAt`, `watermarkOffset`, `intents`), but `generatedAt`
  reflects the current snapshot build time, not necessarily the timestamp of
  the last on-disk projection file
- this snapshot is not the same as daemon startup recovery summary such as
  `projectionMatched` or `catchUp.*`; those are scheduler-recovery diagnostics,
  not the public runtime inspect surface

### `inspect.recovery`

- `listPending()`
- `getPosture(sessionId)`
- `getWorkingSet(sessionId)`

This is the public read model for bounded recovery state.
Mutation of WAL rows is not part of the public runtime contract.

- `getPosture(...)` exposes the recovery mode (`resumable`, `degraded`, or
  `diagnostic_only`) plus any degraded reason derived from canonicalization and
  transition state. `duplicateSideEffectSuppressionCount` is replay-derived from
  durable replay-guard receipts such as consumed or in-flight
  `effect_commitment` blocks; it is not process-local bookkeeping.
- `getPosture(...)` is fully tape-derived. Durable
  `unclean_shutdown_reconciled` receipts explain degraded startup, but later
  recovery transition receipts supersede that degraded posture instead of
  pinning the session on a sticky in-memory diagnostic.
- `getWorkingSet(...)` exposes the recovery-only operational state that must
  stay out of the history-view baseline, such as open tool lifecycle counts,
  pending recovery family, and effect replay guards.
- `inspect.context.getHistoryViewBaseline(...)` exposes the current baseline
  snapshot metadata for operators. The model-visible baseline block is
  intentionally slimmer: digest, lineage, and reference-context metadata stay
  on the inspect surface, while the admitted prompt block carries only the
  history rewrite itself.

### `inspect.lifecycle`

- `getSnapshot(sessionId)`

`inspect.lifecycle` is the runtime-owned aggregate lifecycle contract.

It is a read model, not a second durable truth source. The snapshot composes
replay-owned domain state plus approved lifecycle helpers so runtime, gateway,
and host consumers can get one posture answer for the same durable trace.

Stable axes:

- `hydration`
  - current hydration state plus hydration-local integrity issues
- `execution`
  - `idle | model_streaming | tool_executing | waiting_approval | recovering | terminated`
- `recovery`
  - recovery posture plus transition provenance and recent hosted transition
    history
- `skill`
  - `none | active | repair_required` plus active skill details when present
- `approval`
  - pending approval summary for lifecycle and adapter use
- `tooling`
  - replay-owned open tool call view
- `integrity`
  - aggregate integrity status
- `summary`
  - `cold | active | idle | blocked | recovering | degraded | closed`

Stable rules:

- the snapshot is exported through `SessionLifecycleSnapshot` and is part of
  the public runtime contract
- production projection composes hydrated domain reducers, recovery posture,
  approval state, open tool-call state, hosted transition provenance, and
  runtime-owned session-wire facts
- it does not introduce a parallel raw-event production reducer and it does
  not replace tape, receipts, or Recovery WAL as authority
- adapters should read `summary` first, then axis-specific detail only when the
  local surface genuinely needs more precision
- host-local `SessionPhase` remains a controller FSM for interaction and UI
  orchestration; it does not outrank the runtime lifecycle snapshot
- there is currently no separate public lifecycle subscription surface;
  long-lived transport products still compose live behavior through
  `inspect.sessionWire`, local cache, and runtime events

### `inspect.reasoning`

- `getActiveState(sessionId)`
- `listCheckpoints(sessionId)`
- `getCheckpoint(sessionId, checkpointId)`
- `listReverts(sessionId)`
- `canRevertTo(sessionId, checkpointId)`

This is the public read model for replay-derived reasoning branch state.

Stable rules:

- active branch truth is derived from durable `reasoning_checkpoint` and
  `reasoning_revert` receipts
- `getActiveState(...)` exposes the current branch/root ids, the active
  checkpoint, the active lineage checkpoint ids, and the latest admitted
  revert/continuity packet
- off-lineage or malformed revert targets are ignored during replay; the replay
  fold does not trust write-time validation alone
- `canRevertTo(...)` is lineage-scoped rather than "present anywhere on tape"
- replay-visible reasoning receipts may carry optional linkage to receipt-based
  mutation rollback through `linkedRollbackReceiptIds`, but neither mechanism
  implies the other
- hosted recovery may rebuild model-visible history from this state, but the
  durable branch truth itself remains a runtime inspection surface

### `inspect.events`

- `query(sessionId, query?)`
- `queryStructured(sessionId, query?)`
- `listMetricObservations(sessionId, query?)`
- `listGuardResults(sessionId, query?)`
- `getTapeStatus(sessionId)`
- `getTapePressureThresholds()`
- `getLogPath(sessionId)`
- `searchTape(sessionId, { query, scope?, limit? })`
- `listReplaySessions(limit?)`
- `subscribe(listener)`
- `toStructured(event)`
- `list(sessionId, query?)`
- `listSessionIds()`

`inspect.events` does not expose raw event append.

`inspect.events` is the raw tape inspection surface. It is intentionally wider
than the frontend/session transport contract.

Operator products may summarize or project from this tape, but they do not
replace it. When raw receipt chronology matters, this surface remains the
source to inspect.

`listReplaySessions(...)` enumerates sessions with durable event-tape history.
It is a replay inventory, not a registry of currently attached live sessions.

### `inspect.cost`

- `getSummary(sessionId)`

### `inspect.session`

- `listWorkerResults(sessionId)`
- `getOpenToolCalls(sessionId)`
- `getUncleanShutdownDiagnostic(sessionId)`
- `mergeWorkerResults(sessionId)`
- `getHydration(sessionId)`
- `getIntegrity(sessionId)`

This surface is the operator diagnostic view over current hydrated session
state, unclean-shutdown explainability, and artifact integrity. It is not the
raw event chronology (`inspect.events`) and it is not the frontend/gateway
replay compiler (`inspect.sessionWire`).

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

Operator-only diagnostics such as hydration status, integrity issues, unclean
shutdown explanation, and bounded recovery working state stay on
`inspect.session` / `inspect.recovery` instead of entering this transport
projection.

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

`ToolOutputView` may include `display={summaryText?,detailsText?,rawText?}`.
Runtime replay preserves this presentation metadata on committed tool outputs;
gateway live frames use the same shape when preview output is available.
`summaryText` is reserved for intentional semantic display summaries, while
long raw output without such a summary remains renderer-owned collapse state.

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
- `observePromptStability(sessionId, input)`
- `observeTransientReduction(sessionId, input)`
- `registerProvider(provider)`
- `unregisterProvider(source)`
- `buildInjection(sessionId, prompt, usage?, options?)`
- `appendGuardedSupplementalBlocks(sessionId, blocks, usage?, injectionScopeId?)`
- `checkAndRequestCompaction(sessionId, usage)`
- `requestCompaction(sessionId, reason)`

This surface owns deterministic context admission and explicit compaction
maintenance. Durable compaction receipts are committed through
`authority.session.commitCompaction(...)`, not `maintain.context`. This surface
also carries the current admission-time recovery contract:

- `options.injectionScopeId` selects the branch or leaf scope for duplicate
  fingerprinting and turn-local budgeting
- `options.sourceSelection` narrows the primary provider set without changing
  `collectionOrder`
- `options.referenceContextDigest` is the current stable reference-context
  digest used to reject incompatible history-view baselines during admission

`registerProvider(...)` accepts only providers produced by
`defineContextSourceProvider(...)`. This keeps custom providers on the same
typed construction path as repo-owned built-ins and advisory recall providers.

Like the rest of `maintain.context`, these options shape admission and
maintenance behavior only. They do not authorize effects.

Guarded supplemental delivery is a separate headroom-governed path. Callers
append family-tagged blocks rather than anonymous text so runtime accounting can
preserve family identity independently of primary-source admission.

`appendGuardedSupplementalBlocks(...)` therefore does not register new context
sources. It appends post-primary, family-described exception-lane blocks that
remain outside provider-registry selection, class-budget floors, and source
descriptor inspection.

### `maintain.tools`

- `registerActionPolicy(toolName, input)`
- `registerActionPolicyResolver(toolName, resolver)`
- `unregisterActionPolicy(toolName)`

These are maintenance-time action policy registry operations for custom tools.
They are not read-only inspection and they do not grant runtime capabilities by
themselves. The registry lives in `@brewva/brewva-runtime`; managed tools only
declare an `actionClass` plus their independent `requiredCapabilities`.

### `maintain.session`

- `recordWorkerResult(sessionId, input)`
- `clearWorkerResults(sessionId)`
- `pollStall(sessionId, input?)`
- `clearState(sessionId)`
- `onClearState(listener)`
- `resolveCredentialBindings(sessionId, toolName)`

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

This is the stable public minimum shape for tool-facing runtime access.
Repo-owned managed tools then execute through a capability-scoped facade
derived from their declared `requiredCapabilities`; undeclared `authority.*`,
`inspect.*`, and injected `internal.*` method calls fail closed.

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
this port rather than against the full hosted runtime surface. Command syntax
and transport behavior still live outside this page.

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
