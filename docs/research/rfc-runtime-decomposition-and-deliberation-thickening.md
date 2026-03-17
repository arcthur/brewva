# Research: Runtime Decomposition and Deliberation Thickening

## Document Metadata

- Status: `implemented on mainline`
- Owner: runtime maintainers
- Last reviewed: `2026-03-17`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/configuration.md`

## Direct Conclusion

Brewva's constitutional line, runtime posture model, proposal boundary, and
tape-first durability semantics are aligned with the long-term architecture.
This RFC is now best read as a design record plus regression checklist: the
important work is no longer to invent a new decomposition, but to keep code and
docs from drifting back toward the older, less disciplined shape.

The durable target remains:

1. `BrewvaRuntime` stays a stable domain facade while internal assembly remains
   separated into explicit runtime-owned factory functions, without introducing
   unnecessary public kernel-injection complexity.
2. Deliberation-ring logic belongs in `@brewva/brewva-deliberation`; gateway
   owns lifecycle adapters and host integration, not deliberation state
   machines.
3. Session hydration remains fold-based rather than regrowing a monolithic
   event replay loop.
4. Commitment authorization remains exact and replay-first: durable linkage,
   exact args identity, and consume-on-durable-outcome are part of the contract.
5. Governance remains runtime-scoped, exact-first for managed tools, and
   explicit about trusted-local profiles.

## Target Architecture

The long-term architecture this RFC defends is:

- a thin public `BrewvaRuntime` facade with internal assembly factored into
  runtime-owned factories
- a deliberation package that owns debug-loop, memory curation/formation,
  proactivity planning, and cognitive metrics core logic
- gateway runtime plugins that stay adapter-thin and consume deliberation
  exports instead of re-owning the logic
- fold-based hydration, constructor-sealed config, and runtime-scoped
  governance state as baseline invariants rather than optional refactors
- durable, exact, replay-first commitment semantics with documented
  at-least-once boundaries

## Current Implementation Status (2026-03-17)

Current mainline is substantively aligned to that target:

- implemented: Phase 0 commitment hardening, Phase 1 runtime assembly
  extraction, Phase 2 modular hydration, Phase 3 sealed config, Phase 4
  deliberation package thickening, Phase 5 event query expansion, and Phase 6
  governance tightening/runtime-scoped ownership
- gateway now consumes deliberation exports for memory/debug/proactivity/metrics
  and no longer owns the corresponding core logic
- `BrewvaRuntime` remains the public facade, while assembler logic lives in
  `packages/brewva-runtime/src/runtime-assembler.ts`
- the remaining work is documentation promotion and continued regression
  discipline, not an unfinished phase plan

The problem sections below retain the original architectural motivation, but
the target architecture above is authoritative and the current-status notes
override older pre-implementation wording.

## Remaining Delta

No substantive implementation phase remains open. The residual obligations are:

- keep stable architecture/reference docs synchronized with the implemented
  package ownership and runtime contracts
- keep gateway adapters thin and prevent deliberation logic from drifting back
  into the experience ring
- keep governance/commitment tests explicit so future changes cannot silently
  widen approximation or process-global state

## Problem Statement And Scope

### Problem 1: Runtime Composition Root Conflation

`BrewvaRuntime` historically served three distinct roles:

- `Composition Root`: creates 12 core dependencies + 22 service dependencies,
  wires event subscriptions, and connects cross-service callbacks
- `Domain API Facade`: exposes 13 domain API groups with stable public types
- `Kernel Context Owner`: owns the `RuntimeKernelContext` bag that services
  consume

These three roles were originally tangled in one oversized constructor plus
large in-class service assembly blocks. The consequence:

- adding a new service required touching the central constructor
- changing one service's dependency set risked cascading to unrelated services
- the public facade's stability was coupled to internal assembly details

Current status:

- implemented: the constructor is now a thin shell
  (`packages/brewva-runtime/src/runtime.ts`)
- implemented: core/service/kernel assembly lives in
  `packages/brewva-runtime/src/runtime-assembler.ts`
- clarified target: external pre-built kernel injection is not required for the
  long-term architecture; the important boundary is that assembly is explicit,
  internal, and separate from the public facade

Source evidence:

- `packages/brewva-runtime/src/runtime.ts` (thin constructor + public facade)
- `packages/brewva-runtime/src/runtime-assembler.ts` (core/service/kernel assembly)
- `packages/brewva-runtime/src/runtime.ts` (createDomainApis)

### Problem 2: Deliberation Ring Package Thinness

The design axioms declare:

`make deliberation thicker so it owns path search, retries, reordering, and
lease negotiation`

This was originally violated when gateway owned the core implementations for
debug-loop, memory curation/formation, proactivity planning, and cognitive
metrics.

Current status:

- implemented: `@brewva/brewva-deliberation` now exports the deliberation core
  modules directly (`debug-loop`, `memory-curator`, `memory-formation`,
  `proactivity-engine`, `cognitive-metrics`, plus existing cognition/proposals
  helpers)
- implemented: gateway runtime plugins are now thin lifecycle/host adapters
  that import deliberation exports instead of owning the core logic
- implemented: deliberation modules have direct contract coverage under
  `test/contract/deliberation/**`

The residual rule is architectural rather than migratory: gateway should not
re-accumulate deliberation state machines or duplicate shared deliberation
helpers.

Source evidence:

- `packages/brewva-deliberation/src/index.ts`
- `packages/brewva-gateway/src/runtime-plugins/debug-loop.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`
- `packages/brewva-gateway/src/runtime-plugins/proactivity-engine.ts`
- `packages/brewva-gateway/src/runtime-plugins/cognitive-metrics.ts`

### Problem 3: Monolithic Session Hydration

Historical problem: `SessionLifecycleService.hydrateSessionStateFromEvents()`
used to be a single long event loop that manually folded all session-local
state.

- turn counter
- active skill + tool call count
- verification write markers and evidence
- verification state resets
- skill activation/completion and outputs
- tool call markers
- resource leases (granted / cancelled / expired)
- tool contract warnings
- skill budget/parallel warnings
- pending dispatch recommendations
- skill cascade intent
- ledger compaction turn

Every new event type that needs session-local hydration state requires
extending this single loop with a new `if (event.type === ...)` branch. The
loop also mixes checkpoint-aware cost replay with general event-type
classification, making the control flow hard to follow.

Source evidence:

- `packages/brewva-runtime/src/services/session-lifecycle.ts`

Current status:

- implemented: hydration now dispatches registered `SessionHydrationFold`
  modules (`skill`, `verification`, `resource-lease`, `cost`, `ledger`)
- `hydrateSessionStateFromEvents()` is now a small orchestrator rather than the
  former monolithic loop
- the remaining discipline is to keep new hydration concerns fold-based rather
  than re-growing the orchestrator

### Problem 4: Post-Construction Config Mutation

Historical problem: `createHostedSession` previously mutated `runtime.config`
after construction:

```ts
runtime.config.skills.routing.enabled = true;
runtime.config.skills.routing.scopes = [...new Set(options.routingScopes)];
runtime.skills.refresh();
```

That broke the invariant that config normalization should be a one-time
operation.

Source evidence:

- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `packages/brewva-runtime/src/runtime.ts`

Current status:

- implemented: `routingScopes` is a constructor option
- implemented: `runtime.config` is `DeepReadonly<BrewvaConfig>`
- implemented: hosted paths pass routing overrides through construction and
  throw if a caller attempts to retroactively mutate a pre-built runtime

### Problem 5: Residual Event Query And Observability Gaps

The query surface itself is no longer the main gap. Current residual
observability limitations are:

- `infrastructure.events.level` filters at write time; events excluded by level
  are permanently lost and cannot be replayed for later diagnosis
- audit/commitment events and experience/ops telemetry share the same event
  store by default, so long-running sessions accumulate a mixed stream that is
  harder to reason about as "commitment memory"
- `runtime.events.subscribe(...)` is process-local and ephemeral; it does not
  survive restarts and cannot span process boundaries

Current status:

- implemented: `runtime.events.query(...)` / `queryStructured(...)` /
  `list(...)` now support `type`, `after`, `before`, `last`, `offset`, and
  `limit`
- implemented: store-level tests cover time-range + offset + limit behavior
- remaining: write-time filtering, mixed retention semantics, and
  process-local-only subscription still constrain operational diagnosis

Source evidence:

- `packages/brewva-runtime/src/events/store.ts`
- `docs/reference/limitations.md`
- `docs/reference/events.md`

### Problem 6: Governance Precision Gaps

Two pragmatic compromises weaken long-term governance precision:

1. Tools without governance metadata are allowed with a warning
   (`tool-policy.ts:45-48`). The fallback regex hint set
   (`tool-governance.ts:244-269`) covers only 3 patterns (`read/view/...`,
   `edit/write/...`, `exec/shell/...`), leaving most custom tool names
   completely unclassified.

2. `createTrustedLocalGovernancePort()` defaults all three high-risk options to
   `true` (`allowLocalExec`, `allowScheduleMutation`, `allowExternalEffects`).
   This is correct for personal local development, but makes the answer to
   "Why can we trust this agent behavior?" reduce to "because the host was
   implicitly trusted."

Source evidence:

- `packages/brewva-runtime/src/security/tool-policy.ts`
- `packages/brewva-runtime/src/governance/tool-governance.ts`
- `packages/brewva-runtime/src/governance/trusted-local-port.ts`

Current status:

- implemented: first-party Brewva tools carry exact governance descriptors and
  tests assert metadata alignment with `buildBrewvaTools()`
- implemented: trusted-local governance now uses explicit
  `personal | team | restricted` profiles
- implemented: hint-based fallback emits `governance_metadata_missing` so the
  ambiguity is auditable rather than silent

The remaining obligation is to keep hint-based fallback as a migration aid for
third-party tools, not to let managed first-party tools regress back to it.

### Problem 7: Commitment Replay And Authorization Binding Gaps

This RFC originally tracked three hardening gaps in `effect_commitment`
semantics:

1. consuming approvals too early during `runtime.tools.start(...)`
2. binding explicit resume to `argsSummary` instead of exact argument identity
3. lacking a durable linkage field between approved requests and later tool
   outcomes

Current status:

- implemented: approvals are consumed from durable linked tool outcomes, not
  from start-time authorization
- implemented: explicit resume validates `toolName`, `toolCallId`, and
  canonical `argsDigest`
- implemented: durable tool outcomes now persist both
  `effectCommitmentRequestId` and `toolCallId`

These gaps do not invalidate the overall posture model, but they do weaken the
stronger constitutional reading:

`accepted commitment approval is replayable until the concrete approved effect
has been durably observed, and the approved effect identity is exact.`

What remains true even after the hardening work is the architectural
at-least-once boundary across crashes that happen after the external effect but
before durable observation. That is now a documented contract, not an
unimplemented gap: commitment-posture tools/backends should use request-id
based idempotency keys wherever they can honor them.

Source evidence:

- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
- `packages/brewva-runtime/src/services/ledger.ts`
- `docs/reference/runtime.md`

### Problem 8: Governance Contract And Registry Determinism Gaps

This RFC originally tracked two additional governance determinism gaps:

1. `GovernancePort.authorizeEffectCommitment(...)` is typed as async-capable,
   but the runtime currently treats promise-returning implementations as
   unsupported and converts them into a `defer` decision. The public contract is
   therefore broader than the implemented commitment path.

2. custom tool governance descriptors live in the module-global
   `CUSTOM_TOOL_GOVERNANCE_BY_NAME` map. In multi-runtime or multi-host
   processes, governance policy registration is therefore process-scoped rather
   than runtime-scoped, which weakens determinism and makes policy provenance
   harder to audit.

Current status:

- implemented: `GovernancePort.authorizeEffectCommitment(...)` is now
  synchronous-only in the public contract
- implemented: custom tool governance registration is owned by per-runtime
  `ToolGovernanceRegistry` instances rather than a process-global mutable map
- Phase 6b is therefore no longer pending work; the remaining governance work
  is operational quality and documentation polish rather than registry
  ownership repair

Source evidence:

- `packages/brewva-runtime/src/governance/port.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/governance/tool-governance.ts`
- `packages/brewva-gateway/src/runtime-plugins/index.ts`

## Scope Boundaries

Explicitly in scope:

- internal decomposition of `BrewvaRuntime` while preserving the public domain
  API facade unchanged
- package-level migration of deliberation-ring code from gateway into
  `@brewva/brewva-deliberation`
- modular hydration redesign inside `SessionLifecycleService`
- immutable config model for post-construction runtime instances
- event query surface expansion
- commitment approval lifecycle hardening for `effect_commitment`
- exact authorization binding for explicit commitment resume
- governance precision tightening for first-party tools
- clarifying the `GovernancePort.authorizeEffectCommitment(...)` contract
- moving mutable custom tool-governance registration out of process-global state

Explicitly out of scope:

- changing the constitutional line or ring/plane model
- changing the public `runtime.*` domain API shape
- adding cross-process event streaming or durable consumers
- adding multi-tenant governance models
- removing current safety invariants or replay semantics
- merging CLI/gateway/embedded execution paths into one

## Options Considered

### Option A: Status Quo With Incremental Fixes

Approach:

- keep `BrewvaRuntime` as the single composition + facade class
- add new services by extending the existing constructor
- keep deliberation-ring logic in gateway

Pros:

- zero refactor risk
- no package-graph changes

Cons:

- wiring complexity grows monotonically
- ring boundary audit remains impossible at package level
- hydration loop becomes a permanent maintenance bottleneck
- config mutation hole remains open

### Option B: Full Microkernel Rewrite

Approach:

- decompose runtime into a formal microkernel with plugin-based service loading
- replace constructor wiring with a dependency injection container
- move all non-kernel code into separate extension packages

Pros:

- cleanest long-term architecture
- formal ring enforcement at module level

Cons:

- extremely high migration risk
- requires public API changes
- likely breaks downstream integrations during transition
- over-engineers for current codebase scale

### Option C: Incremental Structural Decomposition

Approach:

- separate composition root from facade (internal refactor, no public API
  change)
- modularize hydration into per-domain fold modules
- migrate deliberation-ring logic from gateway to deliberation package in
  phases
- seal config after construction
- add event query capabilities incrementally

Pros:

- preserves all current invariants and public surface
- each step is independently verifiable
- ring boundary alignment improves gradually
- composition root separation makes future service additions cheaper

Cons:

- requires careful coordination across packages
- intermediate states have split ownership until migration completes

Proposed option: `Option C`

## Why This Direction

This direction follows from Brewva's own stated evolution rules:

- `make deliberation thicker` requires moving deliberation-ring code into a
  deliberation-ring package
- `make contracts lighter` requires the kernel to not also be the assembly
  plant
- `govern effects, not thought paths` is undermined when governance precision
  gaps let unclassified tools bypass the effect model

More concretely:

- the public runtime facade (`runtime.skills.*`, `runtime.proposals.*`, etc.)
  is stable and well designed; the problem is entirely behind the facade
- the constitutional line does not need revision; the package structure needs to
  catch up with the conceptual model
- replay-first approval needs to remain literally replay-first, not merely
  replay-hydrated from past decisions
- session hydration is the highest-risk internal hotspot because it combines
  cross-domain state reconstruction with checkpoint optimization in one loop

## Proposed Implementation Plan

### Phase 0: Harden Commitment Replay And Authorization Precision [Implemented]

Goal: make commitment approval semantics match the stronger replay-first and
exact-binding reading of the architecture before larger structural refactors
lock in current behavior, while explicitly documenting the remaining
at-least-once boundary.

Status: implemented in current mainline. The steps below describe the work that
landed.

Concrete steps:

1. Add persistent linkage fields for commitment execution outcomes:
   `effectCommitmentRequestId` and `toolCallId` become optional fields on
   `FinishToolCallInput`, on tool-result recording inputs, and on the durable
   `tool_result_recorded` event payload
2. Move `effect_commitment` request consumption out of
   `EffectCommitmentDeskService.prepareResume()` / `runtime.tools.start(...)`
   and trigger consumption only from any durable tool outcome record that
   carries commitment linkage, not from start-time authorization
3. Explicitly document crash-after-effect-before-persistence as an at-least-once
   boundary, and recommend commitment-posture tools/backends pass
   `effectCommitmentRequestId` as an idempotency key wherever supported
4. Replace resume-time `argsSummary` matching with a canonical full-args digest
   (or equivalent exact argument identity) while retaining `argsSummary` only
   for operator-facing display/audit text
5. Add contract tests that cover:
   - restart after approval but before durable effect observation
   - exact-match rejection for long-argument collisions
   - single-use consumption after any durable linked tool outcome has actually
     been observed
   - crash-after-effect semantics and idempotency guidance
6. Update proposal-boundary/runtime docs so "matching args" means exact
   canonical identity rather than truncated summary text

Target files:

- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
- `packages/brewva-runtime/src/services/ledger.ts`
- `packages/brewva-runtime/src/types.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `test/contract/runtime/proposals.contract.test.ts`
- `docs/reference/runtime.md`
- `docs/reference/proposal-boundary.md`

Verification:

- durable tool-result payloads carry `toolCallId` and
  `effectCommitmentRequestId` when present
- new contract tests cover restart-before-effect and long-args mismatch cases
- approved requests remain resumable across restart until any durable linked
  tool outcome is recorded
- at-least-once crash-after-effect semantics are documented with idempotency
  guidance
- `bun run check && bun test`

### Phase 1: Separate Composition Root From Facade [Implemented]

Goal: `BrewvaRuntime` remains a thin public facade while internal assembly is
factored into explicit runtime-owned factories.

Status: implemented in current mainline.

Concrete steps:

1. Extract `createCoreDependencies()`, `createServiceDependencies()`, and
   `createKernelContext()` into a standalone `RuntimeAssembler` or factory
   function that returns a `RuntimeKernel` object
2. `BrewvaRuntime` constructor delegates to that internal assembly layer and
   only performs thin runtime wiring plus public domain API projection
3. The internal kernel/assembler types stay non-public; the public surface
   remains `BrewvaRuntime` with exactly the same domain API signatures

Target files:

- `packages/brewva-runtime/src/runtime.ts`
- new internal assembly module under `packages/brewva-runtime/src/`

Verification:

- all existing contract and unit tests pass without modification
- `BrewvaRuntime` constructor line count drops below 50
- `bun run check && bun test`

### Phase 2: Modularize Session Hydration [Implemented]

Goal: replace the monolithic hydration loop with per-domain fold modules.

Status: implemented in current mainline.

Concrete steps:

1. Define a `SessionHydrationFold` interface:

```ts
interface SessionHydrationFold<State> {
  domain: string;
  initial(): State;
  fold(state: State, event: BrewvaEventRecord): State;
  apply(state: State, cell: SessionStateCell): void;
}
```

2. Implement fold modules for each current domain:
   - `SkillHydrationFold`: active skill, tool calls, skill outputs, pending
     dispatch, cascade intent, skill-related warnings
   - `VerificationHydrationFold`: write markers, evidence, check runs, state
     resets
   - `ResourceLeaseHydrationFold`: granted / cancelled / expired leases
   - `CostHydrationFold`: checkpoint-aware cost replay (already partially
     separated)
   - `LedgerHydrationFold`: compaction turn tracking

3. `SessionLifecycleService.hydrateSessionStateFromEvents()` becomes an
   orchestrator that iterates events once and dispatches to registered folds

Target files:

- `packages/brewva-runtime/src/services/session-lifecycle.ts`
- new internal hydration fold modules under `packages/brewva-runtime/src/`

Verification:

- existing hydration tests pass without modification
- new unit tests for each fold module in isolation
- `bun run check && bun test`

### Phase 3: Seal Config After Construction [Implemented]

Goal: eliminate post-construction config mutation.

Status: implemented in current mainline.

Concrete steps:

1. Add a `BrewvaRuntimeOptions.routingScopes` field:

```ts
interface BrewvaRuntimeOptions {
  routingScopes?: SkillRoutingScope[];
}
```

2. Apply routing-scope override during config normalization in the constructor, before
   `Object.freeze()` on the resolved config
3. Make `runtime.config` a `Readonly<BrewvaConfig>` (deep readonly via mapped
   type)
4. Update `createHostedSession` to pass routing override through the
   constructor instead of mutating config post-construction
5. Remove the `runtime.skills.refresh()` call from `createHostedSession`

Target files:

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/types.ts` (add `DeepReadonly<BrewvaConfig>`)
- `packages/brewva-gateway/src/host/create-hosted-session.ts`

Verification:

- TypeScript compiler rejects any `runtime.config.* = ...` assignment
- `bun run check && bun test && bun run test:dist`

### Phase 4: Migrate Deliberation-Ring Logic To Deliberation Package [Implemented]

Goal: align package ownership with ring authority.

Status: implemented in current mainline.

Concrete steps:

1. Phase 4a: migrate pure deliberation logic (no pi extension dependency)
   - implemented: `MemoryCurator`, `MemoryFormation`, and `ProactivityEngine`
     core logic live in `@brewva/brewva-deliberation`
   - implemented: gateway runtime-plugins retain thin adapter wrappers that
     integrate deliberation-package logic with pi extension lifecycle hooks

2. Phase 4b: migrate debug-loop core
   - implemented: `DebugLoopController`, failure-case persistence, retry
     scheduling, and `CognitiveMetrics` core live in
     `@brewva/brewva-deliberation`
   - implemented: gateway retains `registerDebugLoop()` and lifecycle-hook
     adapters

3. Phase 4c: update `@brewva/brewva-deliberation` exports
   - implemented: deliberation exports cover cognition, proposals, records,
     runtime skills, memory, proactivity, debug, metrics, and shared turn
     clock ownership used by both deliberation core and gateway adapters

Workspace package boundaries after migration:

- `@brewva/brewva-deliberation`: proposal producers, memory curation/formation
  core, proactivity core, debug-loop state machine, cognitive metrics core
- `@brewva/brewva-gateway/runtime-plugins`: pi extension lifecycle adapters
  that wire deliberation-package logic into the host execution model

Target files:

- `packages/brewva-deliberation/src/` (new modules)
- `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts` (thin adapter)
- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts` (thin
  adapter)
- `packages/brewva-gateway/src/runtime-plugins/proactivity-engine.ts` (thin
  adapter)
- `packages/brewva-gateway/src/runtime-plugins/debug-loop.ts` (thin adapter)
- `packages/brewva-gateway/src/runtime-plugins/cognitive-metrics.ts` (thin
  adapter)

Verification:

- all existing contract, unit, and system tests pass
- `@brewva/brewva-deliberation` can be tested independently
- `bun run check && bun test && bun run test:dist`

### Phase 5: Expand Event Query Surface [Implemented]

Goal: support operational diagnosis for long-running sessions.

Status: implemented in code and tests; keep docs/limitations aligned so the
documented surface matches the shipped query contract.

Concrete steps:

1. Add time-range filter to `BrewvaEventQuery`:

```ts
interface BrewvaEventQuery {
  type?: string;
  last?: number;
  after?: number; // timestamp lower bound (inclusive)
  before?: number; // timestamp upper bound (exclusive)
  offset?: number; // skip first N matches
  limit?: number; // cap result count
}
```

2. Implement indexed scan in `BrewvaEventStore.list()` for time-range queries
3. Update `runtime.events.query(...)` and `queryStructured(...)` to pass
   through new filters
4. Document the expanded query contract in `docs/reference/runtime.md` and
   `docs/reference/events.md`

Target files:

- `packages/brewva-runtime/src/types.ts` (`BrewvaEventQuery`)
- `packages/brewva-runtime/src/events/store.ts`
- `packages/brewva-runtime/src/services/event-pipeline.ts`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/limitations.md`

Verification:

- new contract tests for time-range and offset queries
- existing event query tests remain stable
- `bun run check && bun test`

### Phase 6a: Tighten Governance Type Contract And Precision [Implemented]

Goal: move from warning-first to exact-first for managed tools and align the
public governance type contract with the actual runtime path.

Status: implemented in current mainline.

Concrete steps:

1. Require exact governance metadata for all first-party Brewva tools
   - implemented: registry completeness is asserted against
     `buildBrewvaTools()` output
   - implemented: tests assert every managed tool carries an exact descriptor

2. Profile-aware trusted-local governance defaults
   - implemented: `TrustedLocalGovernanceProfile` supports
     `personal | team | restricted`
   - implemented: `createTrustedLocalGovernancePort()` accepts explicit
     `profile`

3. Mark regex hint path as deprecated for managed tools and explicit for
   third-party migration
   - implemented: `governance_metadata_missing` records hint fallback use
   - implemented: docs state that, as of `2026-03-17`, no first-party Brewva
     tool may rely on regex hint fallback; hints remain only as a migration path
     for third-party/custom tools until exact metadata is registered

4. Narrow `GovernancePort.authorizeEffectCommitment(...)` to synchronous-only
   - implemented: the public contract is synchronous-only
   - implemented: docs reflect the sync-only commitment authorization path

Target files:

- `packages/brewva-runtime/src/governance/tool-governance.ts`
- `packages/brewva-runtime/src/governance/trusted-local-port.ts`
- `packages/brewva-runtime/src/governance/port.ts`
- `packages/brewva-runtime/src/security/tool-policy.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-tools/src/utils/tool.ts`
- `test/contract/tools/tool-definition-metadata.contract.test.ts`
- `test/contract/runtime/proposals.contract.test.ts`
- `docs/reference/tools.md`
- `docs/reference/runtime.md`

Verification:

- metadata contract test fails if any managed tool lacks exact governance
  metadata
- sync-only governance contract behavior is covered by contract tests
- existing security/tool-policy tests remain stable
- `bun run check && bun test`

### Phase 6b: Make Governance Registry Ownership Runtime-Scoped [Implemented]

Goal: move mutable custom tool-governance ownership out of process-global state
and into the runtime instance that actually owns the policy.

Status: implemented in current mainline.

Concrete steps:

1. Replace module-global mutable custom descriptor state with a
   runtime-owned or assembler-owned registry
2. Gateway/extension registration updates the active runtime instance instead
   of a process-global singleton
3. Add isolation tests for multi-runtime processes with divergent custom tool
   policy

Target files:

- `packages/brewva-runtime/src/governance/tool-governance.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/`
- `packages/brewva-gateway/src/runtime-plugins/index.ts`
- `test/contract/runtime/proposals.contract.test.ts`

Verification:

- custom governance registration is isolated across runtime instances
- gateway/extension registration no longer mutates process-global policy state
- `bun run check && bun test`

## Dependency Graph

Current implementation status:

- Implemented:
  - Phase 0 (commitment semantics)
  - Phase 1 (assembly/facade separation)
  - Phase 2 (modular hydration)
  - Phase 3 (sealed config)
  - Phase 4 (deliberation migration)
  - Phase 5 (event query surface)
  - Phase 6a (governance precision/type contract)
  - Phase 6b (runtime-scoped governance registry)

Remaining dependency notes:

- no substantive phase dependency remains open
- the remaining discipline is regression-oriented: keep gateway adapters thin,
  keep docs synchronized, and prevent any reintroduction of process-global
  governance or approximate commitment binding

## Validation Signals

### Structural Health Signals

Already satisfied in current mainline:

- `BrewvaRuntime` constructor body is under 50 lines after Phase 1
- `SessionLifecycleService.hydrateSessionStateFromEvents()` body is under 50
  lines after Phase 2
- `runtime.config` is compile-time immutable after Phase 3
- commitment approval consumption is no longer triggered from
  `runtime.tools.start(...)`
- `@brewva/brewva-deliberation` export surface now covers memory, proactivity,
  debug, metrics, and shared runtime-turn clock ownership

### Safety Preservation Signals

- all 8 invariants in `docs/architecture/invariants-and-reliability.md` remain
  verified by existing tests throughout every phase
- replay correctness tests in
  `test/contract/runtime/turn-replay-engine-core.contract.test.ts` remain green
- proposal boundary tests remain green
- approved-but-not-yet-executed commitment requests remain replay-resumable
  after restart
- durable tool outcomes can be joined back to the originating approval request
- long-argument commitment resume mismatches are rejected exactly
- docs explicitly state at-least-once crash-after-effect semantics
- dist verification (`bun run test:dist`) remains green

### Governance Precision Signals

- every tool in `buildBrewvaTools()` has an exact governance descriptor
- regex hint usage rate drops to zero for first-party tools
- `governance_metadata_missing` event count is tracked in telemetry
- the implemented `authorizeEffectCommitment(...)` behavior matches its public
  type contract
- custom governance descriptor registration is isolated per runtime instance

### Operational Signals

- event query tests cover time-range, offset, and compound filters
- long-session diagnosis workflows documented in
  `docs/journeys/operations-and-debugging.md`
- docs clearly distinguish commitment/audit events from ops/experience telemetry
  even if they still share storage

## Risks

These are now best treated as regression watchpoints rather than pending-phase
risks.

1. Commitment semantics hardening changed approval lifecycle timing
   and adds durable linkage fields. If the new consume point is chosen
   incorrectly or linkage propagation is incomplete, requests may become
   double-consumable, remain pending forever, or fail to join to their durable
   outcome record.
   - Mitigation: anchor consumption to the same durable execution path that
     records the committed tool outcome, make linkage fields part of the
     persistent contract, and add restart-focused contract tests before
     refactoring surrounding services.

2. Composition root separation touches the most-imported file in the
   runtime package. If internal type boundaries are drawn incorrectly, many
   downstream files need adjustment.
   - Mitigation: the `RuntimeKernelContext` interface already exists as a
     partial extraction; build on that rather than introducing a new type graph.

3. Deliberation migration changed the workspace package graph. If
   `@brewva/brewva-deliberation` gains a dependency on
   `@brewva/brewva-runtime` types that are not yet part of the public export,
   the boundary leaks.
   - Mitigation: deliberation package should depend only on exported runtime
     types, never on internal service types. The existing
     `@brewva/brewva-deliberation` already follows this pattern.

4. Modular hydration may introduce overhead if the fold dispatch
   mechanism adds per-event allocation.
   - Mitigation: fold modules are statically registered, not dynamically
     discovered. The dispatch is a plain array iteration with no allocation per
     event.

5. Sealed config may break undiscovered config mutation sites beyond
   `createHostedSession`.
   - Mitigation: TypeScript compiler will surface all mutation sites when
     `runtime.config` becomes `DeepReadonly`. Fix each site by moving the
     mutation into constructor options.

6. Event query expansion adds indexing overhead to the event store.
   - Mitigation: time-range filters use binary search on the already-sorted
     timestamp sequence; no new index structure needed.

7. Runtime-scoped governance registry may break tests or extensions
   that implicitly relied on process-global custom descriptor registration.
   - Mitigation: add explicit runtime-level registration plumbing and migrate
     tests to register policy through the runtime or assembler that owns it.

## Recommended Resolutions

The following decisions are recommended so implementation can proceed without
reopening first-order design choices during each phase. Items 4 and 7 remain
revisit-worthy after more implementation evidence is available, but the current
recommended default is stated explicitly.

1. Phase 0 consume point: use any durable tool outcome record, not success-only.
   A commitment effect may already have occurred even when the tool reports
   `fail`; consumption must therefore key off durable observation, not
   pass/fail.

2. `RuntimeAssembler` form: use a plain factory function. This matches the
   codebase's current port-creation style and keeps assembly lightweight.

3. `SessionHydrationFold` registration: use static registration. The fold set is
   known at compile time and static registration avoids unnecessary runtime
   indirection.

4. Debug-loop cascade-retry persistence ownership: keep it in
   `@brewva/brewva-deliberation` alongside the rest of the debug-loop core.
   Gateway should stay the lifecycle adapter and host integration layer, not
   reacquire debug-loop orchestration state.

5. `GovernancePort.authorizeEffectCommitment(...)`: narrow to sync-only. The
   current runtime has no awaited commitment authorization path, so promise to
   `defer` is not a sound long-term fallback.

6. `TrustedLocalGovernanceProfile` location: keep it as a constructor option on
   `createTrustedLocalGovernancePort()`. This preserves the explicitness of
   governance-port creation.

7. Write-time event level filtering: recommended default is to leave it
   unchanged in this RFC and revisit after Phase 5 query expansion plus
   telemetry measurement. The issue is real, but widening the storage contract
   now would expand scope beyond the current refactor set.

## Source Anchors

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/runtime-kernel.ts`
- `packages/brewva-runtime/src/services/session-lifecycle.ts`
- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
- `packages/brewva-runtime/src/services/event-pipeline.ts`
- `packages/brewva-runtime/src/services/ledger.ts`
- `packages/brewva-runtime/src/events/store.ts`
- `packages/brewva-runtime/src/governance/tool-governance.ts`
- `packages/brewva-runtime/src/governance/trusted-local-port.ts`
- `packages/brewva-runtime/src/governance/port.ts`
- `packages/brewva-runtime/src/security/tool-policy.ts`
- `packages/brewva-runtime/src/config/normalize.ts`
- `packages/brewva-runtime/src/types.ts`
- `packages/brewva-runtime/src/`
- `packages/brewva-deliberation/src/index.ts`
- `packages/brewva-gateway/src/runtime-plugins/index.ts`
- `packages/brewva-gateway/src/runtime-plugins/debug-loop.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`
- `packages/brewva-gateway/src/runtime-plugins/proactivity-engine.ts`
- `packages/brewva-gateway/src/runtime-plugins/cognitive-metrics.ts`
- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `docs/architecture/system-architecture.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime.md`
- `docs/reference/proposal-boundary.md`
- `docs/reference/events.md`
- `docs/reference/configuration.md`
- `docs/reference/limitations.md`
- `docs/research/roadmap-notes.md`

## Promotion Criteria

This RFC should be promoted into stable docs when:

1. the stable architecture/reference docs describe the implemented package
   ownership and runtime contracts without stale pre-migration wording
2. deliberation modules keep independent contract coverage and gateway adapters
   remain thin over those exports
3. commitment replay, exact binding, hydration, and governance precision
   contract tests remain explicit and green
4. no completed phase in this RFC is described as pending in any promoted doc

## Stable Destinations

- `docs/architecture/system-architecture.md`
  - updated package realization and ring-to-package mapping
- `docs/architecture/design-axioms.md`
  - updated package realization section
- `docs/architecture/invariants-and-reliability.md`
  - new config immutability invariant
- `docs/reference/runtime.md`
  - expanded event query documentation
  - config immutability note
  - exact commitment resume-binding semantics
- `docs/reference/proposal-boundary.md`
  - at-least-once commitment execution note
  - idempotency guidance for commitment-posture tools
- `docs/reference/events.md`
  - expanded query filter documentation
  - new `governance_metadata_missing` event
- `docs/reference/configuration.md`
  - `routingScopes` constructor option
  - governance profile documentation
