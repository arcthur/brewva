# Research: Runtime Axis Decoupling And Vocabulary Boundary

## Document Metadata

- Status: `active`
- Owner: runtime, gateway, tools, and harness maintainers
- Last reviewed: `2026-05-25`
- Acceptance state: not accepted; Phase 5 still has source-of-truth blockers
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/runtime-subpaths.json`

Phase status as of `2026-05-25`:

| Phase | Status  | Review note                                                                                                                                                                                                                                                                                         |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | done    | Vocabulary package and subpath budgets have landed; remaining work is package-by-package import burn-down, not a boundary decision.                                                                                                                                                                 |
| 2     | done    | Runtime construction requires explicit physics and replay/replay-then-real source isolation is covered by contract tests.                                                                                                                                                                           |
| 3     | done    | Kernel and model observation seams have mutation/failure-isolation contract tests.                                                                                                                                                                                                                  |
| 4     | done    | Hosted turn code now has `turn-envelope/`, `session-mux/`, and provider/tool/authority/session binding adapters; fitness keeps provider mechanics out of runtime turn code.                                                                                                                         |
| 5     | partial | Namespace builders, A/B/C labels, context budgets, and generated capability-path equivalence are in place. Promotion is blocked until A-labeled namespaces no longer remain implemented in gateway and the tools typed mirror has a stronger source-of-truth story than schema-equivalence fitness. |
| 6     | done    | Model materialization observation is covered; prompt vocabulary ownership still needs continued doc hygiene as consumers migrate.                                                                                                                                                                   |
| 7     | done    | Runtime per-port directories are in place and the hosted execution-port file is only an ownership barrel.                                                                                                                                                                                           |
| 8     | done    | Runtime subpath documentation is generated from the registry.                                                                                                                                                                                                                                       |

## Problem Statement

The four-port runtime simplification (`docs/research/decisions/four-port-runtime-simplification-rfc.md`)
narrowed the public runtime root to `identity`, `config`, `tape`, `kernel`,
`model`, `start`, `turn`, and `close`. Fitness tests now keep that shape
stable. The constitutional line `Model owns attention. Kernel owns consequence.
Tape owns truth. Runtime owns physics.` is real on the root.

The refactor is finished as a root-shape change. As an architecture step it is
not finished. Complexity that used to live on a flat runtime surface relocated
rather than disappeared. The most important relocation is `runtime.ops`: it is
not on the public root, but it behaves like the factual fifth surface for hosted
code, managed tools, CLI adapters, tests, and channel integrations.

This note frames the next deepening as **axis decoupling**, not as another
round of port surgery. The argument is that the four-port refactor solved the
root authority surface and left several other concerns co-resident inside
runtime-adjacent artifacts:

- product vocabulary formerly lived in `@brewva/brewva-runtime/protocol`; the
  remaining risk is import burn-down and vocabulary subpath budget pressure
- hosted capability and ops vocabulary still partly mirrors the old wide runtime
- physics and reality are implicit construction options
- replay and observation are harness needs without stable seams
- model materialization and prompt vocabulary are split across runtime,
  gateway, and substrate
- topology code still mixes turn execution mechanics with hosted transport

Subsequent simplification has to name those seams before it can subtract
anything substantive.

## Evidence

The numbers below come from the active implementation branch and are
reproducible with `rg`, `wc -l`, and the cited paths.

- The former vocabulary internal body file is removed. Vocabulary internals are
  sliced by domain (`context`, `delegation`, `events`, `iteration`, `schedule`,
  `session`, `skills`, `task`, `wire`, `workbench`) and fitness keeps each
  internal module under an 800-line budget.
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops.ts`: 81
  lines after extracting the typed hosted ops port, removing cast-based
  construction, moving digest helpers to gateway ownership, adding namespace
  labels, and splitting every top-level hosted ops namespace into a physical
  builder under `runtime-ops-builders/`. The 560-line shared hosted ops context is
  bounded separately and only owns state, emit/query helpers, and cross-namespace
  projections; fitness pins the allowed shared state fields so ad hoc maps do
  not quietly accumulate there.
- `packages/brewva-tools/src/contracts/runtime.ts`: 667 lines defining
  `BrewvaToolRuntimeCapabilitiesPort = BrewvaToolRuntimeCommandPort &
BrewvaToolRuntimeQueryPort`, a near-mirror of the hosted ops namespaces.
- Direct `runtime.kernel.*` call sites outside the runtime package: 1 file
  (`runtime-ops-context.ts`).
- Direct `runtime.tape.*` call sites outside the runtime package: 2 files.
- Direct `runtime.ops.*` call sites across gateway and CLI source: 41 files.
- `packages/brewva-runtime/src/runtime/turn/impl.ts`: 384 lines for the
  runtime physics turn loop, with construction/replay mode binding separated
  into `runtime/turn/physics.ts`.
- `packages/brewva-gateway/src/hosted/internal/turn-adapter/`: the former
  958-line `runtime-turn-execution-ports.ts` is now a 7-line ownership barrel;
  provider, tool, authority, and session bindings live in separate modules, and
  live session-wire mux/projection lives under `session-mux/`.
- `packages/brewva-runtime/src/runtime/model/impl.ts`: 317 lines. The model
  port materializes from canonical tape, while hosted context materialization
  and substrate prompt vocabulary live elsewhere.
- `runtime-subpaths.json` registers 4 owned subpaths
  (`./core`, `./schema/...`, `./config`, `./security`), and
  `package-boundaries.md` is generated from that registry. Physics and
  observation remain construction/port-contract seams, not package subpaths.

The pattern is consistent. The narrow root is an honored contract; the wide
runtime still exists next to it under different names.

## Working Hypotheses

The next deepening is governed by six hypotheses.

1. **The four-port refactor solved the public root authority surface and left
   non-authority concerns undescribed.** Continuing to add or remove ports
   without naming those concerns will keep producing relocations rather than
   subtractions.
2. **The largest former implicit coupling in Brewva was `runtime/protocol`,
   not `runtime`.** The runtime protocol alias is now deleted; product packages
   must depend on vocabulary or a package-owned projection instead of a runtime
   package subpath.
3. **`runtime.ops` is the factual fifth surface.** Treating it as only a
   topology artifact understates the risk. It needs its own capability
   compression plan or it will preserve the old wide runtime under a hosted
   name.
4. **Replay payload ownership must be explicit before vocabulary moves.** A
   runtime-only replay contract conflicts with moving product payload types
   out of runtime unless replay type guarantees are deliberately narrowed.
5. **Harness affordances should be seams, not ports.** Replay, observation,
   shadow evaluation, and intervention belong on a different concern from
   authority. Adding them as ports would dilute the four-port constitutional
   shape; refusing to add stable seams keeps harness work as out-of-band
   patches on every consumer.
6. **Attention is under-modeled in this note unless `runtime.model` is given a
   sharper contract.** The first constitutional sentence is about attention,
   not just prompt rendering. Model materialization must be observable and
   explainable without turning runtime into a salience owner.

## Architecture Frame

The earlier draft described six axes. That remains useful for finding mixed
responsibilities, but the axes are not symmetric and must not become six new
subsystems.

### Structural Concerns

These describe how the runtime is built.

| Concern            | What it owns                                                                                              | Current home                                                                                               | Status                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Authority          | allow/block/defer/commit/abort decisions and receipt-bearing truth                                        | `runtime.tape`, `runtime.kernel`; model contributes checkpoint candidates but is not authority             | root clean; surrounding ops still wide       |
| Physics            | provider streaming, tool execution loop, retry discipline, cost/cache receipt normalization, interruption | `BrewvaRuntimeOptions.physics`, `runtime/turn/impl.ts`, hosted provider/tool binding adapters              | explicit, fail-fast                          |
| Vocabulary         | event constants, wire schemas, product domain types, payload readers, helper functions                    | `@brewva/brewva-vocabulary` subpaths; class-A canonical event contracts are exported from the runtime root | package split landed; protocol alias deleted |
| Attention          | model-visible history, materialization decisions, checkpoint candidates, workbench/history-view admission | `runtime.model`, hosted context materialization, substrate prompt vocabulary                               | split and under-specified                    |
| Capability Surface | hosted ops, managed tool runtime facade, capability inventory, extension paths                            | `runtime-ops.ts`, `tools/contracts/runtime.ts`, capability path inventory                                  | factual fifth surface                        |

### Operational Concerns

These describe how runtime is used and inspected.

| Concern     | What it owns                                                                                   | Current home                                                                                                | Status                 |
| ----------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- |
| Reality     | real, replay, replay-then-real, noop construction modes                                        | implicit; `EMPTY_PROVIDER` is the silent fallback                                                           | not modeled            |
| Observation | canonical event observation, materialization observation, shadow decisions, replay-to-anchor   | bespoke wrappers in tests, hosted, CLI, and eval code                                                       | not modeled            |
| Topology    | envelope translation, session multiplexing, watchdog, prelude, schedule trigger, worker bridge | `gateway/hosted/internal/turn-adapter/{turn-envelope,session-mux,provider/tool/authority/session bindings}` | split, fitness-guarded |

Authority is clean only at the public root. The effective architecture is not
clean until vocabulary, ops/capability surface, physics/reality, observation,
attention, and topology each have a smaller, auditable home.

## Scope Boundaries

This note covers:

- the vocabulary seam: where event/wire/product types live and which package
  owns them
- replay payload ownership and type guarantees after product vocabulary moves
- the hosted ops and tool capability surface: which namespaces shrink, move, or
  remain hosted-only
- the reality seam: how a Brewva runtime declares real, replay, replay-then-real,
  or noop execution
- the observation seam: what Brewva exposes for canonical event observation,
  materialization observation, shadow decisions, and replay-to-anchor
- the topology seam: how hosted turn code folds duplicated turn physics back
  into runtime while keeping provider auth, model routing, envelope translation,
  multiplexing, and worker mechanics in the right packages
- the per-port directory shape: keeping each port's contract, implementation,
  and event payloads co-located
- the subpath registry: which document is the single source of truth for runtime
  subpaths

This note does not reopen:

- the four-port public root shape (`identity`, `config`, `tape`, `kernel`,
  `model`, `start`, `turn`, `close`) is preserved
- canonical event type count and the `custom` advisory path
- WAL, approval, rollback, recovery, or projection authority semantics
- Effect infrastructure island boundary
- runtime config schema or persisted formats
- the `single tool call` transaction boundary
- substrate sdk in-memory composition entrypoint scope

## Non-Negotiable Requirements

- The public root continues to satisfy
  `test/fitness/runtime-promoted-architecture.fitness.test.ts`. Root width and
  canonical event count budgets stay or shrink.
- Replay correctness from canonical tape stays packageable as a runtime-only
  concern at the event-structure level. Runtime-only replay guarantees canonical
  event ordering, causal anchors, baseline derivation, and built-in authority
  payloads. Product payload interpretation belongs to the package that owns the
  product vocabulary.
- Existing CLI and channel surfaces continue to work without behavior change
  during the migration. No public CLI flags, channel commands, or persisted
  formats change.
- Net source line count must drop or stay flat across runtime, gateway, tools,
  recall, session-index, and CLI combined. Movement that increases total weight
  is rejected unless a phase-specific exception names the deleted follow-up.
- Every promoted decision in this note must arrive with a fitness test that
  prevents the previous shape from regrowing.
- `@brewva/brewva-vocabulary` must not become a new cathedral: it has no root
  barrel, no dependency on other `@brewva/brewva-*` packages except stable
  foundation types when explicitly approved, and subpath-level surface budgets.
- The hosted ops surface must shrink or split before promotion. It cannot remain
  a 2000+ line mirror of the old runtime while the public root claims victory.

## Decision Options

### Option A: Stop Here

Treat the four-port refactor as the architectural endpoint. Continue to grow
`runtime-ops.ts`, the former `runtime/protocol/body.ts`, and the hosted turn adapter as
they grow today.

Cost:

- per-feature cost stays high. Adding one product event still touches
  `protocol/body.ts`, `runtime-ops.ts`, `session-index/projection`,
  `recall/evidence`, and CLI rendering.
- harness work stays out-of-band. Eval, replay, shadow-run, and replay
  divergence remain per-consumer patches.
- the gap between architecture documentation and code geography keeps widening,
  which is the failure mode the documentation hierarchy invariant exists to
  prevent.
- `runtime.ops` remains the factual fifth surface.

Assessment: rejected as the long-term plan. The narrow root is necessary and
not sufficient.

### Option B: Add A Fifth Port

Promote `runtime.harness`, `runtime.physics`, or `runtime.ops` to a first-class
root port to host replay, intervention, physics declaration, and hosted
capabilities.

Cost:

- inflates the port count and weakens the meaning of "port == authority".
  The constitutional line is currently four; adding a root port that does not
  own authority dilutes the contract.
- blesses the current hosted ops shape instead of subtracting it.
- does not address vocabulary or topology coupling.

Assessment: rejected. The needs are real, but the answer is seam plus capability
compression, not a fifth root port.

### Option C: Axis Decoupling (recommended)

Name the structural and operational concerns. Move the work that belongs on
each concern to a place that matches that concern. Keep the four-port root
unchanged. Add seams and packages where needed, retire centralized cathedrals
where possible.

Cost:

- multi-package migration over multiple release cycles
- requires touching 201 source files and 312 import statements for the
  vocabulary split alone
- requires a deliberate payload-ownership contract so runtime-only replay
  remains true without keeping every product type in runtime
- requires a hosted ops namespace inventory and capability migration, not only
  a turn-adapter cleanup

Benefit:

- per-feature cost drops, because event/product additions land in one
  vocabulary owner and one projection owner instead of five scattered files
- harness, eval, replay, replay divergence, and shadow authority checks become
  first-class without expanding root port count
- the hosted turn adapter becomes a transport and session-mux seam, which is
  what the system architecture document already claims it is
- `runtime.ops` stops acting as an unowned compatibility shell

This note proposes Option C and details its phased shape below.

## Proposed Architecture

### 1. Vocabulary Seam: Delete `@brewva/brewva-runtime/protocol`

The former runtime protocol module did four jobs at once:

- `class A` runtime authority vocabulary: `CanonicalEventType`, built-in
  canonical payloads, receipts, `ToolCommitmentDecision`, kernel/tape replay
  invariants, and authority-bearing helper functions.
- `class B` product wire schemas: `TURN_ENVELOPE_SCHEMA`,
  `SESSION_WIRE_SCHEMA`, `TASK_LEDGER_SCHEMA`, `CLAIM_LEDGER_SCHEMA`.
- `class C` product domain types: `TaskSpec`, schedule intent records,
  `ContextStatus`, session rewind result records, worker merge reports, and
  product `_EVENT_TYPE` constants.
- `class D` helper functions: `parseTaskSpec`,
  `renderTurnConsequenceDigest`, `deriveTurnEffectCommitmentProjection`, event
  readers, reducers, and rendering helpers.

Only class A is runtime authority. Classes B and C are product vocabulary.
Class D is split by ownership rules below.

Target shape:

- The runtime package has no `./protocol` subpath. Class A canonical runtime
  contracts are exported from the runtime root alongside the four-port runtime
  API. Product packages do not import a runtime subpath for vocabulary.
- A new `@brewva/brewva-vocabulary` package owns class B and C vocabulary with
  no dependency on runtime.
- `@brewva/brewva-vocabulary` has no root export. Consumers import only from
  subpaths such as `@brewva/brewva-vocabulary/events`,
  `@brewva/brewva-vocabulary/wire`, `@brewva/brewva-vocabulary/task`,
  `@brewva/brewva-vocabulary/schedule`,
  `@brewva/brewva-vocabulary/context`,
  `@brewva/brewva-vocabulary/delegation`, and
  `@brewva/brewva-vocabulary/workbench`.
- Each vocabulary subpath has a line-count budget, export-count budget, and
  dependency allowlist.
- Runtime may not import vocabulary. Runtime-only replay treats product payloads
  as `ProtocolRecord` / `JsonValue` bags unless the payload belongs to class A.
- Consumers that need product typing parse product payloads through vocabulary
  readers or through their package-owned projections.

Substrate vs vocabulary rule:

- contracts that pass through kernel or tape as durable product facts belong in
  vocabulary
- mechanism contracts for how to call a tool, run a prompt, stream provider
  output, execute a session, or assemble the SDK remain in substrate or
  provider-core
- prompt materialization data shared by runtime and provider execution must be
  classified explicitly before moving; it cannot drift silently between
  vocabulary, substrate, and runtime

Class D helper rule:

- single consumer: move the helper to that consumer package
- two consumers: move the helper to the primary owner package; the second
  consumer imports it directly from the owner package's documented internal or
  public subpath
- three or more consumers: move the helper to vocabulary only when the helper
  is a vocabulary-level parser, reader, or reducer with documented examples;
  otherwise each consumer owns its own rendering logic
- helpers that enforce canonical event invariants, kernel/tape replay
  correctness, or authority receipts stay in runtime-owned kernel/tape/model/turn
  modules or the runtime root type surface as class A

Migration and rollback:

1. Stand up vocabulary with explicit subpaths and no root export.
2. Move migrated class B/C symbols directly to `@brewva/brewva-vocabulary/*`.
3. Remove runtime product vocabulary files instead of keeping compatibility
   re-exports. The runtime `./protocol` subpath is deleted rather than kept as a
   class-A alias.
4. Migrate one product package per PR when done manually. A generated import
   split may cross packages when it is import-only and fully typechecked.
5. Add forbid-level fitness immediately: product packages may not import
   `@brewva/brewva-runtime/protocol`, and the runtime package export map may not
   restore `./protocol`.

Package migration order:

| Order | Package                      | Reason                                                                                                                          |
| ----- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `channels-telegram`          | leaf transport consumer; validates vocabulary import shape with low upstream blast radius                                       |
| 2     | `recall` and `session-index` | read-model consumers; validates product payload readers and semantic projections before tool/CLI surfaces move                  |
| 3     | `tools`                      | capability-heavy consumer; validates that vocabulary split does not widen managed tool runtime access                           |
| 4     | `cli`                        | operator-facing consumer; validates inspection/rendering imports after projections stabilize                                    |
| 5     | `gateway`                    | broadest consumer and hosted assembly owner; migrate last so earlier packages expose drift before the highest-blast-radius move |

Fitness:

- runtime `./protocol` subpath absence
- vocabulary subpath line/export budgets
- no vocabulary root export
- vocabulary dependency allowlist
- no consumers of `@brewva/brewva-runtime/protocol`

This is the single largest blast-radius change in the proposal. It is also the
change that makes every other proposed simplification cheap.

### 2. Replay Payload Ownership

The previous draft claimed runtime-only replay while moving class C product
types out of runtime. That is only coherent if the replay guarantee is precise.

Target contract:

- runtime-only replay guarantees canonical event structure, event order,
  `sessionId`, `turnId`, `attemptId`, anchor boundaries, baseline derivation,
  recovery causes, and built-in class A payloads
- runtime-only replay does not guarantee typed product payload interpretation
  for class B/C vocabulary after the split
- product projections parse product payloads using vocabulary readers or
  package-owned projectors
- replay equivalence has two layers:
  - structural equivalence: runtime-only, canonical event stream and baseline
    equality
  - semantic equivalence: package-owned, typed product projector equality

This avoids a false choice between keeping every product type in runtime and
weakening replay into an untyped free-for-all. Runtime remains authoritative for
canonical truth; product packages own product meaning.

### 3. Hosted Ops And Capability Surface

`runtime.ops` is the factual fifth surface. It cannot be solved by the topology
fold alone.

Target shape:

- Create a namespace inventory for every `HostedRuntimeOpsPort` namespace.
  Each namespace receives one label:
  - `A`: belongs on an existing four-port runtime seam or runtime projection
  - `B`: belongs in substrate, tools, recall, session-index, or another
    package-owned adapter
  - `C`: truly hosted-only and remains in gateway
- The inventory is checked in as an architecture artifact and used by fitness
  tests. It is not an informal spreadsheet.
- Initial labeling examples:

  | Namespace        | Likely label | Reason                                                                                                              |
  | ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
  | `events.records` | `A`          | canonical event observation should converge on `tape.observe` / `tape.replay` when callers need runtime truth       |
  | `delegation`     | `C`          | delegated/background work is hosted control-plane behavior, not default runtime authority                           |
  | `task`           | `B`          | task state is product workflow vocabulary/projection, better owned by substrate/tools/session-index than hosted ops |
  | `workbench`      | `B`          | model-operated memory is advisory/workbench plane, not runtime authority or hosted transport                        |
  | `schedule`       | `B` or `C`   | durable schedule facts should move to a package-owned projection; hosted wakeup orchestration remains gateway-only  |

- Managed tool capabilities remain fail-closed, but the string path inventory
  is generated from typed capability modules rather than hand-maintained as a
  mirror of `runtime-ops.ts`.
- Hosted-only capability modules own their command/query/receipt interfaces.
  Tools depend on those modules, not on a broad `BrewvaToolRuntimeCapabilitiesPort`
  mirror.
- `runtime-ops.ts` remains only as the namespace-label and assembly file.
  Semantic ownership lives in typed namespace builders plus the bounded shared
  context.

Fitness:

- hosted ops namespace inventory covers every top-level namespace
- no unmanaged namespace may be added without an owner label
- generated capability path inventory matches typed capability modules
- `runtime-ops.ts`, `runtime-ops-context.ts`, namespace builders, and
  `tools/contracts/runtime.ts` remain under phase budgets

### 4. Reality Seam: Make Physics Declaration Explicit

`createBrewvaRuntime({ provider, toolExecutor, resolveToolAuthority })`
silently falls back to `EMPTY_PROVIDER` when a port is missing. A turn against
that runtime can emit an empty stream and commit `turn.ended` as if everything
worked.

Target shape:

- Construction takes a `physics` declaration:
  - `physics: { mode: "real", provider, toolExecutor, resolveToolAuthority }`
  - `physics: { mode: "replay", source, until?: EventId }`
  - `physics: { mode: "replay-then-real", source, divergeAt: EventId, provider, toolExecutor, resolveToolAuthority }`
  - `physics: { mode: "noop" }`
- `mode: "real"` requires a non-empty provider and a tool executor.
  Constructing without them is a hard error.
- `mode: "replay"` reads from a tape source and emits frames without calling
  any provider or tool executor. Tool calls replay from recorded
  `tool.committed` / `tool.aborted` events only.
- `mode: "replay-then-real"` replays deterministically until `divergeAt`, then
  switches to real physics for new provider/tool execution. It creates a forked
  runtime lineage or explicit divergence anchor; it must not append divergent
  events to the original read-only tape source.
- `mode: "replay-then-real"` does not replay, mutate, or append to the original
  session's Recovery WAL. The divergence target owns its own WAL and approval
  namespace. Existing approvals may be imported only as explicit evidence and
  must be revalidated before authorizing new post-divergence effects.
- `mode: "noop"` exists for tests and short-lived inspection. Calling
  `runtime.turn(...)` in noop mode fails fast with a typed no-physics error
  before committing canonical events. It must not invent a new
  `RuntimeRecoveryCause` unless the canonical vocabulary is explicitly
  reopened.
- Shared replay sources are read-only. Any mode that can append events must use
  a fork, copy, or explicit writable target.

This formalizes what is currently implicit and closes the silent-empty failure
mode that is hostile to harness work.

### 5. State Classification

Every new seam must declare which state class it uses.

| Item                           | State class                          | Replay source                                                | Write authority                                      |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------- |
| Canonical events               | durable truth                        | runtime tape                                                 | runtime tape/kernel                                  |
| Built-in class A payloads      | durable truth                        | runtime tape                                                 | runtime                                              |
| Product class B/C payloads     | durable product facts                | runtime tape as opaque payloads; product packages parse them | package-owned writers through existing commit paths  |
| Physics declaration            | construction state                   | runtime construction receipt or instance metadata            | runtime construction                                 |
| Replay source                  | read-only input                      | external tape source                                         | none                                                 |
| Replay divergence target       | durable truth for forked run         | forked tape target                                           | runtime tape/kernel after divergence                 |
| Canonical event observer       | observation-only                     | committed events                                             | none                                                 |
| Shadow decision                | durable evidence or harness artifact | real path plus shadow physics input                          | evidence ledger or harness store, not canonical tape |
| Model materialization decision | rebuildable observation              | `MaterializationInput` plus source tape/context              | model/materialization observer                       |
| Hosted ops projection          | rebuildable or hosted-only state     | event tape/session-index/hosted adapter                      | package owner by namespace                           |

Behavior-changing state should remain replay-derived. Visibility-changing state
should be projection-visible. Performance-only and construction-only state must
not masquerade as tape projections.

### 6. Observation Seam: Tape, Kernel, And Model Observers

The runtime package gains observation seams without expanding the four-port
root. They are exposed through existing ports or construction-scoped hooks
rather than as a new root port.

- `runtime.tape.replay(sessionId, { until?: EventId, includeBaseline? })`:
  produces an `AsyncIterable<CanonicalEvent>` that respects baseline derivation
  rules. It is symmetric to `runtime.tape.list` but explicit about replay
  semantics.
- `runtime.tape.observe(filter)`: returns an unsubscribable subscription to
  canonical events as they commit. This consolidates today's
  `runtime.ops.events.records.subscribe` for callers that only need canonical
  events.
- `runtime.kernel.intercept(...)`: observes kernel decisions through an
  isolated context. Interceptors cannot deny a real decision, force a real
  commitment, rewrite payloads, or write canonical events.
- `runtime.model.observeMaterialization(...)` or an equivalent construction
  hook records the `MaterializationInput -> PromptPlan` decision, admitted
  blocks, dropped blocks, source event ids, token estimate, and cache posture.
  It observes attention-related decisions without giving runtime ownership of
  salience.

Interceptor contract:

- interceptors are either construction-scoped or subscription-scoped; runtime
  must not rely on ambient mutable global hooks
- interceptors run after the authoritative decision point they observe unless
  the hook is explicitly named as pre-decision observation
- interceptor failures are isolated and cannot change canonical commit outcome
- interceptor order is deterministic and documented
- interceptors have bounded backpressure behavior; slow observers are dropped,
  buffered with limits, or isolated through a harness-owned queue
- shadow mode requires an explicit shadow physics declaration, such as a
  different authority resolver, model, provider, or policy bundle
- shadow output writes to evidence ledger or harness artifacts, not canonical
  tape, unless a future RFC defines a canonical advisory event path

Fitness:

- interceptors cannot mutate canonical events
- shadow authority decisions can differ from real decisions only through an
  explicit shadow physics declaration
- observer failure does not change real commit outcome

### 7. Attention And Materialization Seam

`runtime.model` should not become a salience owner, but it must be more precise
than a prompt renderer.

Target contract:

- `runtime.model` owns model-visible history materialization from canonical
  replay inputs and checkpoint candidate construction
- hosted workbench, recall, context admission, dynamic tail rendering, and
  product salience stay outside runtime authority
- `PromptMessage`, `PromptPlan`, `MaterializationInput`, and provider-facing
  prompt vocabulary must have one owner. If they are runtime turn contracts,
  they stay in runtime. If they are provider execution contracts, they belong
  in substrate/provider-core. If they become durable product facts, they move
  to vocabulary.
- materialization decisions become observable through the model observer seam
  above so harnesses can answer "what did the model get to see?" without
  scraping rendered prompts
- History-View Plane and Working-Set Plane contracts from the recovery-first
  context RFC remain the place to formalize post-compact model-visible history;
  this RFC must not invent a second hidden recovery hint path

Validation:

- materialization observer tests assert source event ids, admitted blocks,
  dropped advisory blocks, token estimate, and cache posture
- recovery/history-view tests assert baseline equivalence without comparing
  only rendered prompt text

### 8. Topology Seam: Fold Turn Physics, Keep Transport In Gateway

`gateway/hosted/internal/turn-adapter/` currently mixes several
responsibilities:

- envelope translation (channel format -> `TurnInput`)
- session multiplexing (heartbeat, schedule, parallel, recovery)
- worker bridge mechanics
- provider auth, provider fallback, model selection, and cache policy plumbing
- turn physics duplicates (retry/back-off, interrupt handling, cost observation,
  cache stability hooks)

Target shape:

- `gateway/hosted/turn-envelope/` keeps envelope translation only.
- `gateway/hosted/session-mux/` keeps multiplexing, watchdog, prelude,
  schedule trigger, transcript projection, and hosted worker bridge mechanics.
- Runtime owns normalized turn physics decisions and receipts: retry boundary,
  interruption, terminal turn commit, tool continuation limit, canonical cost
  observation, and replay/replay-then-real frame behavior.
- Gateway/provider-core own provider auth, provider selection, model routing,
  provider driver execution, and provider-specific cache rendering. Runtime may
  normalize receipts but should not absorb provider driver mechanics.
- `runtime-turn-execution-ports.ts` shrinks to provider/tool binding adapters
  or is split by ownership. `bindTurnPorts` is replaced by the explicit physics
  declaration on construction.

Fitness:

- a fitness test forbids turn-physics keywords (retry, back-off, interrupt cause
  selection, terminal commit choice, tool continuation policy) from appearing
  in gateway turn-envelope/session-mux code once the migration completes
- provider auth/model-routing keywords remain forbidden from runtime turn code
  unless a later RFC explicitly moves that responsibility

### 9. Per-Port Directory Shape: Co-Locate Contract, Impl, Events

Today `runtime-api.ts` is 551 lines of types for all four ports. Each port's
implementation lives in its own folder, but its contract lives in a shared
file. New code that wants to extend a port has to edit two locations and a
re-export.

Target shape:

- `runtime/{tape,kernel,model,turn}/` each contain:
  - `port.ts` (contract)
  - `impl.ts` (implementation)
  - `events.ts` (port-specific event payloads)
- `runtime-api.ts` keeps only cross-port shared vocabulary (`SessionId`,
  `EventId`, `CanonicalEventBase`, `TurnInput`, `TurnFrame`, `PromptPlan`)
  after those types have been classified by the vocabulary/substrate/runtime
  rules above.
- `runtime/engine/` is renamed to `runtime/turn/` to match the verb name on
  the public root, removing the engine-vs-turn naming drift.

This decision is intentionally small in semantic impact and large in navigation
impact. Every reader who opens `runtime/kernel/` should be able to read the
kernel contract without leaving that directory.

### 10. Subpath Registry: Single Source Of Truth

`skills/project/shared/runtime-subpaths.json` and
`skills/project/shared/package-boundaries.md` disagree on subpath count and
shape. The runtime fitness test reads JSON; humans read Markdown.

Target shape:

- JSON registry remains the authoritative artifact.
- The Markdown table in `package-boundaries.md` is generated from the JSON
  registry by `bun run docs:inventory`.
- The fitness test that compares `runtime/package.json` exports to the JSON
  registry continues to gate adds.
- Physics/reality and observation stay as runtime construction and port-contract
  seams. They are intentionally not `./physics` or `./observation` package
  subpaths until a later decision identifies a standalone public consumer.

## Harness Capabilities Unlocked

This RFC is not only about code geography. The architecture earns its keep when
these harness capabilities become small, repeatable workflows:

- Shadow evaluation: run `mode: "real"` with a shadow interceptor pointed at a
  second model, resolver, or policy bundle, then quantify decision deltas over
  real sessions.
- Replay divergence testing: run `mode: "replay-then-real"` at turn N with a
  different model response or authority resolver and inspect divergence over
  the next N+k events.
- Authority property tests: for arbitrary tapes, assert that observation never
  sees commit-after-block or commit-after-abort sequences.
- Cross-runtime A/B: run the same recorded session through two runtime builds
  and compare cost, latency, tool sequence, and canonical event stream.
- Replay-equivalence CI gate: for a golden session corpus, replay after every
  release and diff canonical event streams plus package-owned semantic
  projections.

## Implementation Phasing

The order matters, but the phases are not fully independent. Vocabulary reduces
import coupling first. Physics/reality and topology are coupled. Observation
can land in layers: canonical event observation first, then replay divergence
and shadow mode, then materialization observation.

### Phase 1: Vocabulary Boundary

- Audit the former `runtime/protocol/body.ts` and label every export A/B/C/D.
- Stand up `@brewva/brewva-vocabulary` with subpaths and no root export.
- Add dependency fitness so vocabulary does not depend on runtime, gateway,
  tools, recall, session-index, CLI, provider-core, or substrate unless an
  explicit exception is documented.
- Define replay payload ownership before moving class C symbols.
- Move class B and C vocabulary directly to vocabulary subpaths.
- Apply Class D helper rules.
- Migrate one major package per PR off `@brewva/brewva-runtime/protocol`.
- Add forbid-level import fitness once migration lands.
- Remove runtime product body/types/evidence files in the same phase.
- Promotion after Phase 1: update `system-architecture.md`,
  `reference/events/README.md`, `package-boundaries.md`, and
  `runtime-subpaths.json` for vocabulary ownership. Do not wait for all later
  phases.

### Phase 2: Reality Declaration And Replay Semantics

- Add `physics: PhysicsDeclaration` to `BrewvaRuntimeOptions`.
- Remove top-level `provider` / `toolExecutor` / `resolveToolAuthority` from
  `BrewvaRuntimeOptions`; callers must declare physics explicitly.
- Implement `mode: "real"` fail-fast construction.
- Implement `mode: "replay"` as tape-driven replay with no provider or tool
  executor calls.
- Implement `mode: "replay-then-real"` with `divergeAt` and explicit fork or
  writable target semantics.
- Implement `mode: "noop"` as construction-only/no-turn physics that fails
  before committing canonical events.
- Add tests for replay tool-output behavior, read-only source behavior, and
  divergence target isolation.
- Implementation note: the deprecated-alias window was waived. All in-tree
  consumers moved in the same merge train, so the branch used a hard cutover
  instead of keeping one-release aliases for `provider`, `toolExecutor`, or
  `resolveToolAuthority`.
- Promotion after Phase 2: `reference/runtime.md` gets a Physics and Reality
  section.

### Phase 3: Observation And Harness Seams

- Add `tape.replay` and `tape.observe` where they fit existing port semantics.
- Add kernel interception with isolated failure, deterministic ordering, and
  no canonical mutation.
- Add shadow mode only with explicit shadow physics declaration.
- Add model materialization observation or construction hook.
- Move existing `runtime.ops.events.records.subscribe` consumers to canonical
  observation where their need fits canonical events.
- Add contract tests that observer failure does not affect commit outcome and
  interceptors cannot mutate canonical events.
- Promotion after Phase 3: `reference/runtime.md` gets an Observation section
  and harness docs list the unlocked capabilities.

### Phase 4: Topology Fold

- Identify each retry/interrupt/cost/cache decision in hosted turn code.
- Move normalized turn physics decisions into `runtime/turn/`.
- Keep provider auth, model routing, provider fallback, and provider driver
  mechanics in gateway/provider-core.
- Split `gateway/hosted/internal/turn-adapter/` into `turn-envelope/`,
  `session-mux/`, and provider/tool binding adapters.
- Retire `bindTurnPorts` in favor of physics declaration.
- Add fitness tests for turn-physics absence from hosted transport code and
  provider-driver absence from runtime turn code.
- Completion gate: `runtime-turn-adapter.ts` remains orchestration-only, live
  session-wire frame projection lives under `session-mux/`, and
  `runtime-turn-provider.ts` stays below its topology-fold soft ceiling.

### Phase 5: Runtime Ops And Capability Compression

- Create the hosted ops namespace inventory and label every namespace A/B/C.
- Move A-labeled needs to existing four-port seams or runtime projections only
  when they are truly runtime concerns.
- Move B-labeled needs to substrate, tools, recall, session-index, or other
  package-owned adapters.
- Keep C-labeled needs in gateway hosted modules.
- Replace hand-maintained capability string mirrors with generated inventory
  from typed capability modules. Until the package graph can make one typed
  surface derive from the other, schema-equivalence fitness must instantiate
  hosted ops and assert every generated `capabilities.*` path is implemented.
- Shrink `runtime-ops.ts` into an assembler over typed namespace builders.
- Add line/export budgets for `runtime-ops.ts`, shared hosted ops context,
  namespace builders, and `tools/contracts/runtime.ts`.
- Completion gate: A-labeled namespace implementations remaining in gateway
  must be zero, or each remaining A label must name the runtime four-port seam
  it is waiting on. The shared hosted ops context may not add new state fields
  without updating the explicit fitness inventory.
- Promotion after Phase 5: `system-architecture.md` must describe the hosted
  ops compatibility seam and its owner labels.

### Phase 6: Attention And Materialization Contract

- Classify `PromptMessage`, `PromptPlan`, `MaterializationInput`, and related
  prompt vocabulary as runtime, substrate/provider-core, or vocabulary owned.
- Add materialization observation tests.
- Align runtime model materialization with History-View Plane and Working-Set
  Plane contracts.
- Document that runtime model observes and materializes model-visible history
  but does not own salience, recall ranking, or hosted workbench admission.

### Phase 7: Per-Port Directory + Naming

- Move per-port type fragments out of `runtime-api.ts` into per-port `port.ts`
  files after vocabulary and prompt ownership are settled.
- Rename `runtime/engine/` to `runtime/turn/`.
- Update fitness tests and documentation cross-references.

### Phase 8: Subpath Single-Source

- Make the Markdown table in `package-boundaries.md` generated from
  `runtime-subpaths.json`.
- Verify in `bun run test:docs` that the generated table matches.

## Source Anchors

- Runtime root: `packages/brewva-runtime/src/runtime/runtime.ts`,
  `packages/brewva-runtime/src/public/index.ts`
- Runtime types: `packages/brewva-runtime/src/runtime/runtime-api.ts`
- Runtime turn implementation: `packages/brewva-runtime/src/runtime/turn/impl.ts`
- Runtime tape: `packages/brewva-runtime/src/runtime/tape/impl.ts`
- Runtime kernel: `packages/brewva-runtime/src/runtime/kernel/impl.ts`
- Runtime model: `packages/brewva-runtime/src/runtime/model/impl.ts`
- Vocabulary boundary: `packages/brewva-vocabulary/src/internal/*`; the runtime
  `./protocol` subpath is intentionally deleted.
- Hosted ops cathedral:
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops.ts`,
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-port.ts`,
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ports.ts`
- Hosted turn adapter:
  `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-adapter.ts`,
  `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.ts`
- Tool capability mirror:
  `packages/brewva-tools/src/contracts/runtime.ts`
- CLI runtime port adapter:
  `packages/brewva-cli/src/runtime/runtime-ports.ts`
- Substrate prompt and mechanism vocabulary:
  `packages/brewva-substrate/src/prompt`,
  `packages/brewva-substrate/src/tools`,
  `packages/brewva-substrate/src/provider`,
  `packages/brewva-substrate/src/session`
- Subpath registry:
  `skills/project/shared/runtime-subpaths.json`,
  `skills/project/shared/package-boundaries.md`
- Fitness anchors:
  `test/fitness/runtime-promoted-architecture.fitness.test.ts`,
  `test/fitness/runtime-subpath-registry.fitness.test.ts`,
  `test/fitness/package-boundary-vnext.fitness.test.ts`

## Validation Signals

- `bun run check` and `bun test --timeout 600000` continue to pass through every
  phase.
- Fitness tests on runtime root width, canonical event count, and runtime
  subpath registry continue to pass.
- New fitness tests:
  - runtime `./protocol` subpath absence
  - vocabulary subpath line/export budgets
  - no vocabulary root export
  - vocabulary dependency allowlist
  - warning-then-forbid import gate for migrated vocabulary symbols
  - hosted ops namespace inventory coverage
  - generated capability inventory matches typed capability modules and is
    implemented by hosted runtime ops
  - turn-physics keyword absence in hosted transport/session-mux code
  - provider-driver keyword absence in runtime turn code
  - interceptor cannot mutate canonical events
  - observer failure does not affect real commit outcome
  - shadow mode cannot differ from real mode without explicit shadow physics
  - `physics: "real"` without provider or tool executor fails to construct
  - `mode: "replay"` never calls provider or tool executor
  - `mode: "replay-then-real"` never appends divergent events to the original
    read-only tape source
- Per-phase line-count diff: net source lines across runtime, gateway, tools,
  recall, session-index, and CLI must be flat or negative unless the phase
  names an explicit deletion follow-up.
- Replay equivalence:
  - structural equivalence: runtime-only canonical event sequence and baseline
    equality
  - semantic equivalence: package-owned typed projector outputs match for the
    product packages under test
- Debug journey:
  given `sessionId + turnId + toolCallId`, a maintainer can locate provider
  frame, model materialization decision, kernel decision, tape receipt, hosted
  projection, and operator display through documented paths.

Phase fitness index:

- Phase 1: protocol budget, vocabulary subpath budgets, vocabulary dependency
  allowlist, warning-then-forbid import gate
- Phase 2: `physics: "real"` requires provider/tool executor, replay never
  calls provider/tool executor, replay-then-real never appends to source tape
- Phase 3: interceptor cannot mutate canonical events, observer failure
  isolation, shadow requires explicit physics
- Phase 4: turn-physics keyword absence in hosted transport/session-mux,
  provider-driver keyword absence in runtime turn code
- Phase 5: namespace inventory coverage, generated capability inventory match,
  hosted ops implementation of every generated capability path, hosted ops
  assembler/context/builder budgets, hosted ops shared-state field inventory,
  hosted ops/tool mirror line budgets
- Phase 6: materialization observer coverage and prompt vocabulary ownership
  classification
- Phase 7: per-port contract co-location and turn directory naming fitness
- Phase 8: generated subpath documentation freshness

## Architecture Tax Metrics

LOC is a floor, not the main proof. The retro should also track:

| Metric                                                               | Current                                                                                           | Target                                         | Phase              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------ |
| `@brewva/brewva-runtime/protocol` package-source importer count      | 201 source files                                                                                  | 0                                              | End of Phase 1     |
| Product-package import statements from runtime protocol              | 312                                                                                               | 0                                              | End of Phase 1     |
| Average files touched to add one common product event                | estimated >= 5 (`protocol/body.ts`, `runtime-ops.ts`, projection, recall/evidence, CLI rendering) | <= 2                                           | End of Phase 5     |
| Sample shadow-eval harness size                                      | effectively unbounded/out-of-band                                                                 | <= 20 lines for minimal real-plus-shadow setup | End of Phase 3     |
| `runtime-ops.ts` plus `tools/contracts/runtime.ts` mirror line count | 748                                                                                               | <= 800                                         | Phase 5 completion |
| Hosted ops physical implementation line count                        | 2433 (`runtime-ops.ts`, bounded context, namespace builders)                                      | <= 2500                                        | Phase 5 completion |

## Surface Budget

| Surface area                                      | Before                                                                  | After                                                                                     | Notes                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Public runtime root members                       | 8                                                                       | 8                                                                                         | unchanged                                                            |
| Canonical event types                             | 14                                                                      | 14                                                                                        | unchanged unless a later RFC explicitly reopens vocabulary           |
| Runtime subpaths (registry)                       | 5                                                                       | 4                                                                                         | `./protocol` deleted; documentation generated from registry          |
| `runtime/protocol` exports                        | ~716                                                                    | 0                                                                                         | subpath deleted; class A contracts stay on runtime root              |
| Vocabulary root exports                           | n/a                                                                     | 0                                                                                         | subpath-only package                                                 |
| Vocabulary subpaths                               | n/a                                                                     | >= 3, budgeted                                                                            | wire/events/task/context/etc.                                        |
| Required authored fields on `createBrewvaRuntime` | 0                                                                       | 1 (`physics.mode`)                                                                        | provider/toolExecutor only when mode requires real physics           |
| Reality modes                                     | implicit                                                                | real, replay, replay-then-real, noop                                                      | explicit construction declaration                                    |
| Observation concepts                              | bespoke wrappers                                                        | tape replay, tape observe, kernel intercept, model materialization observe                | seams, not root ports                                                |
| Inspect surfaces                                  | `runtime.ops.events.records.*`, etc. via hosted                         | hosted unchanged during migration; canonical observation also reachable from runtime tape | additive then subtractive                                            |
| Hosted ops surface                                | 2528-line ops file plus 599-line tool mirror                            | typed hosted ops port, namespace inventory, physical namespace builders, and budgets      | Phase 5 owns the builder/context budget and capability mirror budget |
| Routing/control-plane decision points             | session mux, schedule trigger, watchdog, recovery mixed in turn-adapter | session mux, schedule trigger, watchdog, recovery in hosted mux; physics in runtime turn  | clarification, not addition                                          |

Net required authored fields delta: +1 (`physics.mode`). Debt owner: runtime
maintainers. Why unavoidable: the silent fallback to `EMPTY_PROVIDER` is a
correctness hazard for harness work and incompatible with replay-first
architecture. Re-evaluation trigger: after Phase 2 lands, audit whether mode
defaults are sufficient to avoid the field becoming a friction tax.

Net author-facing concept delta is larger than the earlier draft claimed.
Public root concepts stay fixed, but maintainer/harness concepts become
explicit: `physics`, `replay`, `replay-then-real`, `intercept`, `shadow`,
`observeMaterialization`, `turn-envelope`, `session-mux`, and vocabulary
subpaths. This is acceptable only if the same work deletes broader hidden
concepts from gateway, CLI, tools, and tests.

## Non-Goals

- not changing the four-port public root shape
- not changing canonical event type count in this RFC
- not adding new root ports
- not introducing a new control-plane plane
- not changing config schema, persisted formats, CLI flags, or channel commands
- not changing approval, rollback, recovery, or projection authority
- not removing the gateway hosted adapter; it remains the transport and hosted
  control-plane seam Brewva needs
- not moving provider auth, provider driver mechanics, or model routing into
  runtime unless a later RFC explicitly changes the gateway/provider-core
  contract
- not making advisory memory, workbench notes, or recall results into compact
  baseline truth

## Promotion Criteria

This note should not remain active until all phases land. Each phase promotes
its completed contract into stable docs when it lands.

Phase-level promotion:

- Phase 1 promotes vocabulary ownership and replay payload ownership.
- Phase 2 promotes physics/reality construction semantics.
- Phase 3 promotes observation and harness seams.
- Phase 4 promotes topology ownership between runtime, gateway, and
  provider-core.
- Phase 5 promotes hosted ops and capability ownership.
- Phase 6 promotes attention/materialization ownership.
- Phase 7 promotes per-port directory layout.
- Phase 8 promotes generated subpath documentation.

The whole note can convert to a decision record with the same title when:

- Phase 1 has landed and runtime `./protocol` is deleted with import/export
  fitness gates in place.
- Phase 2 has landed and physics declaration is the documented runtime
  construction contract.
- Phase 3 has landed and observation seams have contract tests that forbid
  canonical event mutation and isolate observer failure.
- Phase 4 has landed and hosted transport/session-mux code no longer carries
  turn physics decisions.
- Phase 5 has landed and `runtime.ops` is a compatibility assembler over typed
  capability modules with an owner-labeled namespace inventory.
- Phase 6 has landed and `runtime.model` materialization is observable without
  owning salience.
- Net source line delta is flat or negative across the affected packages or all
  approved exceptions have completed their named deletion follow-up.
- `system-architecture.md`, `design-axioms.md`, and `reference/runtime.md`
  carry the axis decoupling contract.
- `package-boundaries.md` and `runtime-subpaths.json` agree on subpath
  ownership.

Current blockers to full promotion, reviewed against code on `2026-05-25`:

- A-labeled `runtime.ops` namespaces are still implemented in gateway builders
  even when their target ownership is runtime four-port projection.
- `tools/contracts/runtime.ts` and `runtime-ops-port.ts` are guarded by
  generated capability-path equivalence, but their command/query type surfaces
  are not yet mechanically derived from one typed source.
- The active file should be moved to `docs/research/decisions/` only after the
  two blockers above are closed or explicitly accepted as follow-up decisions.

## Related Notes And Decisions

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
- `docs/research/decisions/authority-surface-narrowing-and-runtime-facade-compression.md`
- `docs/research/decisions/runtime-public-root-compression.md`
- `docs/research/decisions/effect-infrastructure-island-boundary-rfc.md`
- `docs/research/active/event-stream-consistency-and-replay-fidelity.md`
- `docs/research/active/recovery-first-context-governance-and-history-view-baselines.md`
- `docs/research/active/context-control-plane-simplification.md`
