# Research: Context-Control Plane Simplification

## Document Metadata

- Status: `active`
- Current state: implementation landed, not promoted
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-05-17`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/tools/delegation.md`
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Problem Statement

Brewva should keep its distinctive control-plane posture:

- delegated work is explicit, opt-in, and inspectable
- background work can survive the parent turn and produce late outcomes
- worker changes require parent-controlled adoption
- runtime authority remains replay-first and receipt-based
- the hosted default path stays narrow

The current implementation reaches those goals with too many overlapping
mechanisms. Delegation run lifecycle, context rendering, context manifest
writing, compaction recovery, and event projections each carry parts of the same
semantic chain. That makes the system harder to change than it needs to be.

The goal of this RFC is subtraction, not a new platform layer. Brewva should
remain more capable than a small CLI agent, but its implementation should be
compressed around a few deep modules with small interfaces.

## Design Thesis

Brewva should optimize for a narrow default path and explicit control-plane
power. The design should preserve durable delegation and replay-safe context
governance while deleting duplicate lifecycles, speculative public seams, and
stringly side-effect tracking.

The target architecture is:

1. one delegation finalization path and only one detached IPC adapter
2. one immutable context record used by hosted context and delegation
3. one pure compaction policy shared by every compaction caller
4. event tape as authority, with session-index views as rebuildable caches
5. no new public routing concepts unless an operator workflow requires them

## Scope Boundaries

This RFC covers:

- gateway delegation orchestration
- detached background delegation protocol boundaries and context handoff
- hosted dynamic context composition and compaction trigger coordination
- session-index-backed parallel and delegation read models
- public documentation of the simplified control-plane contract

This RFC does not cover:

- changing the public `brewva` command
- changing `subagent_run`, `subagent_fanout`, `subagent_fork`,
  `subagent_status`, `subagent_cancel`, or `worker_results_apply` semantics
- adding hidden auto-spawn behavior
- making subagent output auto-apply to the parent workspace
- changing `session_compact` as the only replay-visible history rewrite
- changing WAL, approval, rollback, or proposal authority semantics
- adding provider-specific cache APIs
- adding an open context-source plugin registry
- turning specialist roles into independent implementation plugins

## Non-Negotiable Requirements

- Default hosted execution must not get wider. Background and parallel work
  remain explicit control-plane behavior.
- Public delegation keeps the role-first surface: `agent` plus optional
  compatible `skillName`.
- Child workers cannot expand authority beyond the resolved execution plan, and
  worker patch output remains inert until the parent applies it.
- Detached runs remain a supported capability for durable background work.
- File-system IPC for detached runs must be hidden behind a small adapter
  interface and tested as an implementation detail.
- Context budget limits must be enforced by code, not only rendered as prompt
  guidance.
- Context manifests must describe the materialized context artifact, not just
  the run objective and reference list.
- Parallel and delegation read models should use rebuildable session-index
  views by default. Any in-memory cache must justify itself with measured
  latency or event-loop isolation needs.
- Legacy compatibility logic must be quarantined or deleted when it no longer
  protects a supported persisted contract.
- Audit-only A2A surfaces must either gain a delivery contract within two
  release cycles after this RFC starts implementation or be deleted.
- The implementation must be net-negative by at least 800 lines across the
  source anchors before promotion.

## Proposed Architecture

### 1. Collapse Delegation Around One Run Lifecycle

Current friction:

- in-process delegation and detached background delegation duplicate run record
  creation, context handoff, child preparation, finalization, and cleanup
- role behavior and background protocol details leak too far across resolver,
  execution plan, prompt construction, and finalization

Target shape:

- `DelegationRunPlan` is the resolved immutable input to execution.
- `DelegationRunFinalizer` owns structured outcome parsing, patch capture,
  worker result recording, lineage outcome recording, and lifecycle event
  completion.
- `runDelegation(plan, options)` is a function, not a service object. It owns
  prepare, run, finalize, and cleanup ordering.
- the in-process path is the default inline implementation.
- `DetachedRunAdapter` is the only adapter interface. It hides child-process
  spawning, file-system IPC, live state, cancellation files, and detached
  outcome loading.
- specialist roles remain catalog metadata and prompt overlays, not separate
  implementation plugins.

Deletion targets:

- duplicated completion record construction between in-process and detached
  paths
- duplicated patch capture and worker result finalization
- duplicated structured outcome extraction
- scattered release-slot logic
- symmetric adapter factories, adapter registries, and test-only third adapters
- direct file-system protocol calls outside the detached adapter

### 2. Make Context A First-Class Bundle

Current friction:

- hosted dynamic context, inherited subagent context, delegation prompt context,
  and detached context manifests are separate renderings
- `contextBudget.maxTurnTokens` is not a hard injected-context budget
- `contextRefs` are locators rather than validated materialized inputs

Target shape:

- `ContextBundle` is an immutable serializable record, not a service.
- `buildContextBundle(input): ContextBundle` is pure.
- the bundle contains source references, admitted references, materialized
  blocks, token budget, admission status, stable fingerprints, and manifest
  metadata.
- hosted dynamic tail rendering consumes a bundle.
- delegation prompt construction consumes a bundle.
- detached run manifests persist the bundle itself plus its hash. There must not
  be a second "manifest schema vs bundle schema" truth split.
- fork context rendering uses the same session-context projection rules as
  hosted context.

Budget overflow policy:

- required blocks are admitted before advisory blocks; advisory blocks are
  dropped by declared priority until the bundle fits
- a block may only be truncated when its producer declares a deterministic
  strategy
- if required context still exceeds budget, hosted turns return a compaction
  requirement and delegated runs fail admission with an explicit blocker
- overflow must never silently create a prompt-only fallback path

Deletion targets:

- independent context string builders with divergent inclusion rules
- manifest files that do not identify the actual admitted context
- prompt-only budget guidance with no enforcement
- stringly side-effect lists such as `effects: string[]`

### 3. Replace Side-Effect Lists With Typed Receipts

Current friction:

- context materialization reports side effects through string names
- callers cannot statically tell which side effects were emitted or skipped
- telemetry, prompt-stability evidence, and surfaced delegation outcomes are
  coupled in one broad materialization function

Target shape:

- pure context builders return blocks and fingerprints.
- `buildContextMaterializationReceipt(...)` is pure and returns a typed
  description of what should be observed, emitted, recorded, or surfaced.
- the hosted lifecycle caller is the single effect runner that translates the
  receipt into telemetry, prompt-stability evidence, and surfaced delegation
  outcome updates.
- tests assert the receipt data and separately assert the single caller's
  receipt-to-effect mapping.

Deletion targets:

- `effects: string[]`
- effectful telemetry emission from context builders
- side effects hidden in block producers or spread across block ordering tests

### 4. Share One Pure Compaction Policy

Current friction:

- manual compaction, auto-compaction, and model-downshift recovery have separate
  trigger logic and retry behavior
- runtime budget advisory and gateway recovery policy can drift
- the implementation is harder to reason about than the public contract:
  `session_compact` is the only replay-visible history rewrite

Target shape:

- `decideCompaction` is a pure function:
  `(inputs, breakerState) => Decision`.
- manual model-requested compaction, auto-compaction, and model-downshift
  recovery call the same policy.
- breaker, cursor, and retry state live in existing durable or rebuildable
  state: event tape first, session-index rows when a rebuildable read model is
  enough.
- every accepted decision still commits through `session_compact`.
- gateway recovery may dispatch compaction work, but it must not create a
  second history-rewrite authority.

Deletion targets:

- duplicated threshold checks
- duplicated fallback-model selection
- duplicated output-budget escalation
- recovery paths that look like independent compaction engines

### 5. Fold Projections Into Session-Index Views

Current friction:

- delegation and parallel state use in-memory maps backed by event replay
- hydration metadata can look like a second source of truth
- repeated full replay creates cost and makes the source-of-truth model harder
  to see

Target shape:

- event tape remains the only authority.
- parallel and delegation read models are session-index views by default.
- each view records a cursor, event count, and schema version.
- reconciliation means "advance the session-index view from cursor", not
  "rebuild the world" unless the cursor is invalid.
- in-memory projection classes are allowed only when measured latency or
  hosted-loop isolation proves session-index access is too expensive. If
  allowed, they remain request-scoped caches over the session-index view.

Deletion targets:

- ad hoc hydration flags outside projection ownership
- full replay on routine slot admission when a valid cursor is available
- code paths that update projection maps without an event source
- parallel/delegation-specific map projections that duplicate session-index
  semantics

## Effect Boundary

Pure builders in this RFC do not import `@brewva/brewva-effect`. Remaining side
effects stay at explicit edge runners:

- detached process spawning and file-system IPC should flow through the existing
  Effect boundary where platform resources are crossed
- hosted telemetry and event writes should stay in the hosted lifecycle caller
  that applies a typed receipt
- this RFC does not introduce a new Effect service or runtime layer

## Borrowed Lessons Worth Keeping

- From Claude Code: stable prompt prefixes, explicit volatility, request-local
  reduction that does not mutate replayable history, and persistence before
  long provider or child-run calls.
- From Pi Mono: small context values, transformation as the main context seam,
  and compaction boundaries represented by explicit indexes or baselines.
- Brewva should not copy their smaller scope by removing durable background
  delegation, collapsing authority into CLI process state, replacing
  replay-first receipts with request-local shortcuts, or inventing specialist
  plugin implementations before multiple real implementations exist.

## Surface Budget

This RFC is a subtraction RFC. It should not add public operator-authored
surface.

| Surface                               | Before | After | Delta |
| ------------------------------------- | -----: | ----: | ----: |
| Required public authored fields       |      0 |     0 |     0 |
| Optional public authored fields       |      0 |     0 |     0 |
| Author-facing control-plane concepts  |      8 |     5 |    -3 |
| Inspect surfaces                      |      5 |     5 |     0 |
| Routing/control-plane decision points |      7 |     4 |    -3 |

Concepts compress from delegation target, agent spec, execution envelope,
result mode, context refs, context budget, materialization effects, and
compaction recovery to delegation run plan, context bundle, materialization
receipt, compaction policy, and session-index view cursor. Inspect surfaces stay
stable; routing decisions collapse to role/skill resolution, authority/result
posture, context-bundle admission, and detached execution handoff.

## Current Implementation Review

Reviewed on `2026-05-17` after the context-control plane implementation and
stable-doc updates.

Implemented and validated:

- in-process and detached runs both build `DelegationRunPlan` values and use
  the shared delegation finalization receipt path for terminal run outcomes
- `DetachedRunAdapter` is the only detached adapter interface; in-process
  execution remains inline
- hosted dynamic context, delegation prompts, fork context, and detached run
  handoff use immutable serializable `ContextBundle` values
- detached context handoff persists the admitted bundle and hash as
  `.orchestrator/subagent-runs/<runId>/context-bundle.json`
- detached run specs are latest-only artifacts; Brewva does not migrate stale
  `.orchestrator/subagent-runs/` entries across binary upgrades, so old
  detached workers must be stopped and the run directory cleared before
  retrying work after an upgrade
- context materialization now produces typed receipts, with hosted lifecycle as
  the single receipt-to-effect runner
- manual, hosted auto-compaction, and model-downshift callers share the pure
  `decideCompaction(...)`
- session-index exposes delegation and parallel read-model views with cursor,
  event-count, and schema-version metadata
- subagent-scoped A2A audit messaging is removed; `agent_send`,
  `agent_broadcast`, and `agent_list` remain channel A2A tools only

Promotion is still blocked:

- source-anchor line budget is not met. The current measured source-anchor diff
  is `+1002/-1360`, net `-358`, below the required `-800`.
- the finalization property test that generates random plans and child
  outcomes for byte-identical in-process/detached receipts has not been added.
- runtime parallel slot admission still reconciles the hot in-memory slot
  ledger from the runtime event tape. Session-index parallel views exist for
  read models, but cursor-backed slot admission or measured evidence for the
  runtime-local exception is still required before promotion.

Verification already run for the implementation:

- `bun run check`
- `bun test --timeout 600000`
- `bun run test:property`
- `bun run test:docs`
- `git diff --check`

## Migration Plan

### Phase 0: Freeze New Surface

- Delete audit-only A2A surfaces unless they gain a delivery contract within two
  release cycles after this RFC starts implementation.
- Record the starting line-count baseline for the source anchors and require a
  net reduction of at least 800 lines before promotion.

### Phase 1: Extract Delegation Finalization

- Move structured outcome parsing, patch capture, worker result recording,
  lineage recording, and completion lifecycle payload creation into one
  finalizer.
- Make in-process and detached paths call the same finalizer.
- Keep public behavior unchanged.

### Phase 2: Introduce ContextBundle

- Build a bundle for hosted dynamic tail rendering.
- Use the same bundle shape for delegation prompt construction.
- Persist the bundle and bundle hash in detached run manifests.
- Enforce injected-context budgets before prompt construction.
- Add overflow tests for priority dropping, declared truncation, compaction
  requirement, and delegated-run blocker behavior.

### Phase 3: Replace Materialization Effects

- Replace string effect lists with `ContextMaterializationReceipt`.
- Keep receipt construction pure.
- Move receipt-to-telemetry and receipt-to-surfacing effects into one hosted
  lifecycle caller.
- Keep block producers pure.

### Phase 4: Centralize Compaction Policy

- Introduce the pure `decideCompaction`.
- Route manual, auto, and model-downshift recovery decisions through the same
  policy.
- Keep `session_compact` as the only replay-visible history rewrite.

### Phase 5: Move Read Models To Session-Index Views

- Add explicit cursors to session-index delegation and parallel views.
- Rebuild only when a cursor is invalid or the view schema changes.
- Delete in-memory projection classes unless measured latency justifies a
  request-scoped cache.
- Quarantine legacy event normalization in migration-only modules.

## Validation Signals

- property tests generate random plans and child outcomes and prove in-process
  and detached finalization produce byte-identical receipts
- cancellation always releases the parallel slot exactly once
- patch-producing workers never mutate parent workspace state before
  `worker_results_apply`
- context bundle tests enforce token budget before prompt assembly and cover
  priority dropping, explicit truncation, hosted compaction requirement, and
  delegated-run admission blockers
- context manifest tests prove detached runs record admitted context identity
- materialization tests assert typed receipt data and receipt-to-effect mapping
- property tests prove manual, auto, and downshift callers share
  `decideCompaction` semantics for equivalent inputs
- session-index view tests prove replay rebuild and cursor advancement agree
- line-count check proves the implementation is net-negative by at least 800
  lines across the source anchors
- docs tests keep promoted operator language aligned with implementation

## Source Anchors

- `docs/journeys/operator/background-and-parallelism.md`
- `docs/journeys/internal/context-and-compaction.md`
- `packages/brewva-gateway/src/delegation/orchestrator.ts`
- `packages/brewva-gateway/src/delegation/background/controller.ts`
- `packages/brewva-gateway/src/delegation/background/runner-main.ts`
- `packages/brewva-gateway/src/delegation/background/protocol.ts`
- `packages/brewva-gateway/src/delegation/prompt.ts`
- `packages/brewva-gateway/src/delegation/fork-context.ts`
- `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
- `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
- `packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.ts`
- `packages/brewva-runtime/src/domain/parallel/parallel.ts`

## Promotion Criteria

This RFC can be promoted when:

- delegation finalization has one implementation used by in-process and detached
  runs
- `DetachedRunAdapter` is the only adapter interface and in-process execution
  stays inline
- context bundle identity and serialized bundle content are present in hosted
  context and detached delegation manifests
- context materialization returns pure typed receipts and the hosted lifecycle
  caller owns receipt effects
- manual, auto-compaction, and model-downshift recovery share one pure policy
- delegation and parallel read models are session-index views with explicit
  cursors, or documented measured evidence justifies a request-scoped cache
- implementation diff is net-negative by at least 800 lines across source
  anchors
- stable docs explain the simplified contract without introducing new public
  knobs
