# System Architecture

## Philosophy

Brewva is a commitment runtime.

The system optimizes for one question:

`Why can we trust this agent behavior?`

Constitution:

`Intelligence proposes. Kernel commits. Tape remembers.`

Implementation-grade reading:

`Intelligence explores. Kernel authorizes effects. Tape remembers commitments.`

Design priority:

1. evidence and replayability
2. bounded execution and cost
3. deterministic context control
4. operator-friendly contracts

Further reading:

- `docs/architecture/design-axioms.md`
- `docs/reference/proposal-boundary.md`
- `docs/reference/runtime.md`

## Interpretation Order

When architecture documents disagree in tone or granularity, interpret them in
this order:

1. `docs/architecture/design-axioms.md`
2. `docs/architecture/invariants-and-reliability.md`
3. `docs/architecture/system-architecture.md`
4. explanatory product-shape or flow descriptions such as
   `docs/architecture/cognitive-product-architecture.md`,
   `docs/architecture/exploration-and-effect-governance.md`, and
   `docs/architecture/control-and-data-flow.md`

This file defines authority maps and state taxonomy. It should stay more stable
than product-shape narratives or flow snapshots.

Use this file to answer:

- who owns authority
- which state is authoritative versus derived
- which classes of product behavior are allowed to stay advisory-only

Do not use broad plane language from lower-precedence documents to widen kernel
authority, durable control state, or default-path prescriptions.

## Three Rings

- `Kernel Ring`
  - commitment
  - effect gates
  - verification
  - replay and recovery
- `Deliberation Ring`
  - evidence-backed artifact folding and retrieval
  - deliberation memory, promotion drafts, and optimization continuity
  - optional search or delegation assistance outside kernel authority
  - future multi-model reasoning products
- `Experience Ring`
  - CLI
  - gateway
  - channels
  - operator UX

Boundary rule:

- outer intelligence may propose
- kernel may accept, reject, or defer
- every committed decision produces a receipt
- tape is commitment memory, not a best-effort debug log

## Interactive Shell Boundary

The interactive CLI lives in the `Experience Ring` and now uses a dual-layer
operator shell model.

- `@brewva/brewva-cli`
  - owns shell state, semantic keybinding contexts, overlay priority, operator
    actions, and transcript / approval / question / task / inspect / session
    truth
- `@brewva/brewva-tui`
  - owns terminal capability policy and the OpenTUI quarantine boundary
- OpenTUI
  - owns rendering, editor, viewport, layout, cursor, and selection mechanics
  - does not own Brewva session or operator truth

Boundary rules:

- the default home remains one conversation shell
- approvals, questions, tasks, inspect, session switching, and pager drill-down
  render as overlays or pagers over the same Brewva truth
- the root `@brewva/brewva-tui` surface stays Node-safe for dist smoke and
  non-interactive imports
- the Bun/OpenTUI runtime loads only after CLI mode resolution commits to
  interactive full-screen execution
- the first OpenTUI-backed shell standardizes on
  `screenMode: "alternate-screen"`
- Brewva currently pins `@opentui/core` to `0.1.100` and uses
  `@opentui/solid` as the only interactive renderer binding

## Substrate Boundary

Between the kernel ring and the experience ring, Brewva now treats the
`substrate` as the execution foundation rather than as an informal host
implementation detail.

- substrate owns session lifecycle driving
- substrate owns turn-loop and stream orchestration
- substrate owns tool execution phases and host-facing tool surfaces
- substrate owns prompt/context resource loading and session persistence bridges
- hosted, CLI, and channel routes all run on that same repo-owned substrate
- Pi compatibility is limited to import/export and reference-study value, not
  runtime-path dependency

Kernel boundary reminder:

- kernel still owns effect taxonomy, authorization/defer/deny/allow semantics,
  verification authority, and receipt-bearing rollback
- substrate growth must not be used to widen kernel authority vocabulary

## Operational Planes

- `Working State Plane`
  - projection
  - context arena
  - active tool surface
  - derived workflow artifacts and posture snapshots
- `Cognitive Product Plane`
  - context composition
  - identity rendering
  - capability disclosure
  - model-facing recovery hints
- `Control Plane`
  - heartbeat triggers
  - scheduling triggers
  - subagent orchestration
  - hosted TaskSpec-first bootstrap and routing-posture guidance
  - hosted turn transitions and bounded recovery posture
  - replayable delegation outcome handoff
  - future orchestration helpers

Rings define authority. Planes define product behavior.

Boundary note:

- rings outrank planes when authority is in question
- naming a plane does not create new authority by itself
- planes may explain presentation or orchestration, but they must not be used
  to justify hidden stage machines, default injected lane briefs, or
  model-writable control state

## Current Transaction Boundary And Platform Growth Rule

The current stable authority-bearing transaction boundary is `single tool
call`.

That boundary means Brewva currently provides durable semantics for:

- tool-call classification
- proposal / approval / exact resume
- durable linked tool outcomes
- rollback-bearing mutation receipts where the effect model supports rollback

It does not currently provide a stable contract for:

- cross-agent saga semantics
- generalized compensation graphs
- automatic partial-failure repair across delegated runs
- default-path backpressure guarantees across the broader control plane

Gateway-internal hosted turn continuation is now a named control-plane loop,
but it does not change the kernel transaction boundary. The hosted thread loop
may recover, retry, compact-resume, reasoning-revert-resume, suspend, or fail a
turn, while effect authority still stays at the receipt-bearing tool boundary.
Kernel-level turn transactions or cross-agent compensation still require a new
focused RFC.

Platform-growth rule:

- new orchestration breadth that widens the default hosted or runtime-plugin
  path should land as opt-in control-plane behavior
- exceptions should stay narrow, preserve the current `single tool call`
  boundary, and carry an explicit compatibility story for events, WAL, and
  integration seams
- planes may describe orchestration products, but they must not silently turn
  advisory routing into an assumed protocol dependency

## Context Governance Objects

Context governance uses three different object kinds. They are related, but they
are not interchangeable:

- `Primary Registry Sources`
  - source-typed provider contracts owned by the runtime
  - carry plane, admission-lane, scheduling, dependency, and preservation
    metadata
  - participate in deterministic admission, source selection, arena planning,
    and provider inspection
- `Guarded Supplemental Families`
  - host-local post-primary block families appended through a separate
    headroom-governed exception lane
  - do not masquerade as primary sources and do not participate in provider
    selection or arena class floors
- `Composer Policy Blocks`
  - render-local policy artifacts such as compaction gate or capability policy
  - carry provenance for observability and model presentation
  - are not admitted source objects

Boundary rules:

- only primary registry sources are source-typed context providers
- hosted `contextProfile` compiles `sourceSelection` from primary-source
  descriptors rather than from duplicated source tables
- guarded supplemental families stay explicit exception paths and must not become
  silent continuity carriers
- composer policy blocks remain presentation artifacts; they do not widen
  runtime authority or create a second source taxonomy

## Adjacent Repository Fitness Plane

Brewva's architecture is centered on the `runtime commitment plane`.

That plane answers:

`Why can we trust this agent action or runtime commitment?`

An adjacent but different problem is `repository fitness`:

- whether a repository change is safe enough to review, merge, release, or
  escalate
- which deterministic gates should block early
- which risky diffs should route to deeper validation or human review

Brewva may later integrate repository-fitness evidence, but Brewva does not
own repository merge or release authority by default. Session-local
verification, workflow posture, and ship-posture summaries must not be
misread as a full repository fitness engine.

Allowed interaction pattern:

- repository-fitness systems may expose explicit external surfaces such as CI
  verdicts, review-routing summaries, or change-fitness reports
- hosts may import that evidence through policy adapters, explicit tools, or
  other non-kernel control-plane wiring
- external repository judgment should remain legible as imported evidence
  rather than silently turning session-local runtime surfaces into merge
  authority

Boundary reminder:

- delegated `qa` may execute adversarial checks and produce release-confidence
  evidence
- `runtime.authority.verification.*` remains the kernel authority over whether
  evidence is sufficient and fresh for session completion
- neither surface becomes repository merge or release authority on its own

## Repository-Native Precedent Layer

Brewva now treats repository-native engineering precedent as an adjacent
control-plane product, not as kernel authority.

Stable decisions:

- `docs/solutions/**` is the canonical repository-native precedent store
- precedent retrieval and maintenance happen through explicit surfaces such as
  `knowledge_search`, `recall_search`, `precedent_audit`, `precedent_sweep`,
  and `knowledge_capture`
- these surfaces may inform planning, debugging, review, and repository-fitness
  judgment, but they do not create a `runtime.knowledge.*` domain and they do
  not widen effect authority
- `review` may use an internal multi-lane ensemble, but the public review
  boundary remains one advisory surface and does not become repository merge
  authority

## State Taxonomy

| Category                 | Role                                                                                 | Authority                    | Typical carriers                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `Kernel Commitments`     | authoritative system commitments                                                     | authoritative                | tape, receipts, task, truth, ledger                                                           |
| `Working State`          | session-local working view and budgeted context admission                            | non-authoritative            | projection, context arena, active tool surface                                                |
| `Narrative Memory`       | typed collaboration semantics and selective recall                                   | non-authoritative            | self bundle, narrative memory records, explicit promotions                                    |
| `Deliberation Artifacts` | non-kernel evidence, derived memory, recall ranking state, and optimization sediment | non-authoritative            | deliberation memory, recall broker state, promotion drafts, optimization continuity artifacts |
| `Tool Surface`           | turn-visible action surface                                                          | policy-governed              | base tools, skill-scoped tools, operator tools                                                |
| `Control Plane`          | scheduling, delegation, and operator-facing orchestration                            | non-authoritative by default | schedulers, wake prompts, child-run controllers                                               |

Important distinctions:

- projection is working state, not long-term memory
- narrative memory is a non-authoritative cognitive product, not kernel truth
- repository precedent remains explicit under `docs/solutions/**`, not hidden
  inside memory products
- broker-first hosted recall is still a deliberation product; it changes the
  default read path, not the authority boundary
- default broker recall scope is `user + repository root`; broader
  workspace-wide or cross-workspace recall is policy-gated, and worktrees do
  not share recall automatically by default
- workflow artifacts/posture are derived working-state views, not new
  commitment-memory event families
- `skill_completed` outputs are durable producer evidence, while normalized
  semantic artifact views are derived consumer read models layered on top of
  that evidence
- advisory or taxonomy-only normalization drift does not become kernel truth
  just because a normalized view exists
- session-scoped workflow posture is not repository merge or release
  authority
- iteration facts are durable event evidence for model-native optimization
  loops, not a runtime-owned optimizer state machine
- reasoning branch continuity is a kernel commitment when it becomes a durable
  `reasoning_checkpoint` or `reasoning_revert` receipt; the exploratory path
  itself remains discardable until then
- context arena is an injection planner, not a memory system
- tool surface should reflect the current commitment boundary, not the whole
  static capability catalog

State visibility rule:

- behavior-changing state should be replay-derived when it affects admission,
  authorization, or recovery semantics
- visibility-changing state should surface through projection or explicit
  inspection products
- runtime-owned lifecycle meaning should be composed once and published through
  a shared inspect surface rather than rediscovered independently by adapters
- performance-only caches may remain local, but losing them must not widen
  authority or change replayable commitments
- frontend session replay is an experience-ring read model: `session-wire.v2`
  compiles durable receipts and merges cache-class live previews, including
  attempt-scoped live tool telemetry, but it does not become kernel authority
  or a second wire log

Hosted recovery note:

- `HostedThreadLoop` is the gateway-internal continuation owner above the
  low-level model/tool loop
- hosted entrypoints resolve an explicit profile such as `interactive`,
  `print`, `channel`, `scheduled`, `heartbeat`, `wal_recovery`, or `subagent`
  before running the loop
- `session_turn_transition` is a rebuildable control-plane surface for hosted
  continuation, interruption, and bounded-recovery posture
- it explains why hosted execution continued or retried; it does not authorize
  effects, approvals, rollback, or replay truth
- `HostedTurnTransitionCoordinator` remains event-derived state and breaker
  posture; it is not the hosted business-policy engine
- thread-loop diagnostics are internal and sanitized; prompt text and provider
  payloads do not become public runtime inspect state
- runtime lifecycle aggregate composes hydration, approval, open tool calls,
  recovery posture, hosted transitions, and terminal receipts into one posture
  contract for host and gateway consumers
- host `SessionPhase` and gateway `session.status` are subordinate controller
  or transport views over that aggregate plus local live concerns; they are not
  parallel durable semantics
- hosted tool execution traits may shape scheduler behavior, but they remain a
  control-plane concern rather than a kernel authority descriptor
- hosted reasoning revert is also a control-plane continuation surface:
  `reasoning_revert_resume` explains how the user-facing turn continued after a
  durable branch reset, but the branch truth itself remains on tape

## Durability Taxonomy

Stable durability language is narrower than the broader state taxonomy above.

The repository uses four durability classes:

- `durable source of truth`
  - losing the surface changes authority, committed history, authorization, or
    replay outcomes
- `durable transient`
  - bounded crash-recovery, dedupe, or rollback material that is not final
    authority
- `rebuildable state`
  - persisted derived state that may be dropped and reconstructed from durable
    truth plus workspace state
- `cache`
  - latency or UX helper material whose loss must not change correctness

Default mappings in Brewva:

- event tape, checkpoints, reasoning-branch receipts, task/truth/schedule
  intent events
  - `durable source of truth`
- Recovery WAL and rollback patch/snapshot history
  - `durable transient`
- working projection, workflow posture, and other derived inspection products
  - `rebuildable state`
- channel helper state, routing hints, and other UX continuity helpers
  - `cache`
- transient outbound provider-request reduction and other request-copy-only
  prompt-shaping helpers
  - `cache`

Boundary rule:

- no advisory plane may claim source-of-truth durability just because it is
  persisted
- rebuildable and cache-class surfaces must never become hidden authority
  inputs
- `Control Plane` surfaces default to `cache` unless an explicit crash-recovery
  argument narrows them into `durable transient`

## Public Surface Interpretation

`BrewvaRuntime` may expose a public facade that is wider than the smallest
authority contract. That width must not be read as authority width.

Stable interpretation should distinguish three kinds of public surface:

- `stable runtime facade`
  - `runtime.authority`
  - `runtime.inspect`
  - `runtime.maintain`
  - narrower role ports derived from the same semantic contract
- `authority-facing contract`
  - effect authorization
  - proposal / approval / exact resume
  - durable linked outcomes
  - task commitment writes and closure records
  - truth commitment writes
  - schedule intent create, update, and cancel
  - verification sufficiency
  - rollback identity
- `operator / inspection surface`
  - event, ledger, cost, integrity, and replay inspection products
  - schedule read models such as list and projection views
  - tool access explanation and similar query-only views
- `rebuild / maintenance surface`
  - context refresh and admission helpers
  - skill refresh and registry rebuild
  - WAL-backed crash-recovery helpers
  - raw tape-recording escape hatches and explicit session-maintenance helpers

Interpretation rules:

- `public` does not mean `equally authoritative`
- semantic root surfaces should compress toward authority width even when
  inspection and maintenance remain rich
- surface tiering applies at the method or method-group level, not at the
  namespace level
- rich inspection and recovery surfaces may remain explicit
- default host, plugin, and skill coupling should prefer the narrowest surface
  that preserves correctness
- raw durability mechanisms should not become the default product vocabulary
  when a narrower receipt, verification report, or read model would suffice
- Tier 2 is read-only; APIs that write tape, mutate session state, mutate
  runtime-owned registries, or change admission state belong to Tier 1 or Tier
  3
- explicit access to WAL-backed recovery state, ledger, projection, and related rebuild helpers
  may be necessary for audit, undo, recovery, and inspection, but that does
  not make them the default semantic center for surrounding products

## Core Kernel

### Trust Layer

- `EvidenceLedger`
- `VerificationService`
- `TruthService`

### Boundary Layer

- `ToolGateService`
  - effect authorization
  - approval requirements
  - rollback receipt creation
- `SessionCostTracker` + `CostService`
- `ContextBudgetManager` + compaction gate

### Contract Layer

- `SkillLifecycleService`
- `TaskService`

### Durability Layer

- event tape
- checkpoint + delta replay
- Recovery WAL

## Iteration-Fact Substrate

Runtime may persist a small set of objective optimization facts:

- metric observations
- guard results

These facts are durable evidence that can be replayed, queried, and surfaced
through advisory projections. They do not give the runtime authority to choose
the next experiment, define loop strategy, or own an optimizer state machine.

## Context Model

Context injection is single-path and deterministic:

- governed source registration
- arena budgeting and deduplication
- global budget clamp
- hard-limit compaction gate

Projection and arena are not parallel memories:

- projection provides one deterministic working snapshot
- arena budgets which admitted sources fit the current turn
- working projection and `workflow_status` read from durable events and working
  state, but they remain explicit/advisory rather than prescribing a path

Model-facing composition is separate:

- runtime admission decides which sources are allowed
- `ContextComposer` decides how admitted blocks are shown to the model
- default hosted session behavior is broker-first within the narrative recall
  path
- the hosted system prompt carries one static Brewva context contract; live
  pressure and threshold numbers stay in turn-scoped hidden-tail blocks rather
  than in the session-cached prompt prefix
- the model may choose any valid path unless an independent governance boundary
  blocks it

## Tool Surface

The runtime/runtime-plugin stack treats tool surface as three layers:

- `base tools`
- `skill-informed tools`
- `operator tools`

Visible surface helps the model understand available paths, but authority sits
on effect classes, approval requirements, rollbackability, and resource ceilings.

Hosted interactive turns now resolve the pre-skill surface through an explicit
TaskSpec-first control-plane posture:

- when no skill is active and no TaskSpec is recorded, the visible surface may
  narrow to bootstrap control-plane tools so the next semantic decision is
  `task_set_spec`
- once TaskSpec exists, the hosted path narrows again to a
  `skill_load_required` posture when a routed skill is retained
- these posture changes are visible control-plane shaping plus replayable
  receipts such as `skill_recommendation_derived`; they do not activate skills
  automatically and they do not create a runtime-owned planning state machine

## Governance Port

`BrewvaRuntimeOptions.governancePort` is optional and governance-only:

- `authorizeEffectCommitment`
- `verifySpec`
- `detectCostAnomaly`
- `checkCompactionIntegrity`

Current host defaults:

- CLI-owned runtimes install
  `createTrustedLocalGovernancePort({ profile: "personal" })`
- gateway/hosted/channel runtimes install
  `createTrustedLocalGovernancePort({ profile: "team" })`
- raw runtimes without a governance port fail closed by routing approval-bound
  effectful actions through the replayable operator desk rather than silently
  auto-authorizing them

This preserves the kernel promise: the kernel governs execution, but adaptive
selection logic stays outside the core path.

External repository-fitness systems may still interact with Brewva through host
policy, explicit tools, or imported evidence. That integration should feed the
runtime as external judgment input rather than expanding the kernel into a
repository merge controller.

## Related Docs

- `docs/architecture/design-axioms.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime.md`
- `docs/reference/proposal-boundary.md`
- `docs/reference/budget-matrix.md`
- `docs/guide/overview.md`
