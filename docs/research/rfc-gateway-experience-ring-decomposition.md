# Research: Gateway Experience-Ring Decomposition for Channel Host and Context Lifecycle

## Document Metadata

- Status: `promoted`
- Owner: gateway/runtime maintainers
- Last reviewed: `2026-03-29`
- Promotion target:
  - `docs/reference/runtime-plugins.md`
  - `docs/journeys/operator/channel-gateway-and-turn-flow.md`
  - `docs/architecture/control-and-data-flow.md`

## Direct Conclusion

Brewva should keep the current hosted session and channel-mode contracts, but it
should decompose two oversized experience-ring implementations:

1. `packages/brewva-gateway/src/channels/host.ts`
2. `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`

This RFC does **not** recommend changing kernel authority, replay semantics,
tool-gating contracts, or the hosted lifecycle contract.

It recommends a narrower change:

- keep the same runtime-facing behavior
- keep the same replay and governance invariants
- move orchestration-heavy experience-ring logic into smaller, auditable
  adapters with explicit responsibilities

The architectural reason is simple:

`experience-ring complexity should stay legible and decomposable, even when the product grows`

Strong models do not remove the need for these surfaces. They remove the need
for planner-shaped compensation layers. They do **not** remove the need for:

- transport/session orchestration
- turn ordering and replay-safe dispatch
- context-injection lifecycle adapters
- compaction safety and operator-facing diagnostics

Those responsibilities remain valuable. The problem is not that they exist. The
problem is that each current implementation owns too many of them at once.

## Problem Statement And Scope

### Problem 1: `channels/host.ts` is carrying too many control concerns

`runChannelMode(...)` currently mixes:

- channel transport bootstrap
- runtime bootstrap
- conversation/session binding
- agent runtime lifecycle and eviction
- inbound queueing and WAL handoff
- orchestration command handling
- controller replies
- update-lock coordination
- A2A bridge wiring
- prompt dispatch and outbound turn delivery

That is too much authority-free orchestration in one file.

The result is not a kernel problem. It is an experience-ring maintenance
problem:

- local changes require reconstructing too much global state
- regression risk is high because transport, command routing, and dispatch
  share one control body
- tests naturally become integration-heavy because there are few narrow seams
- the file becomes the hidden source of truth for channel behavior

### Problem 2: `runtime-plugins/context-transform.ts` is carrying too many lifecycle concerns

`createContextTransformLifecycle(...)` currently mixes:

- lifecycle hook registration
- turn clock and gate state bookkeeping
- auto-compaction watchdog control
- context injection orchestration
- capability-view support assembly
- supplemental block assembly
- context composition
- telemetry emission
- delegation-outcome surfacing

This is not a wrong concept. The hosted path does need a context lifecycle
adapter. The problem is that one implementation currently owns nearly the
entire adapter stack.

That makes the boundary harder to reason about:

- context composition behavior and compaction behavior are coupled in one file
- lifecycle hooks become harder to test in isolation
- event emission policy is mixed with orchestration policy
- future compression of advisory/context surfaces becomes harder because the
  control flow is centralized

### In Scope

- decomposition of `channels/host.ts` into smaller internal adapters
- decomposition of `runtime-plugins/context-transform.ts` into smaller internal
  adapters
- contract-preserving internal APIs and module boundaries
- test-shape changes needed to keep behavior stable

### Out Of Scope

- changing runtime authority or proposal boundaries
- changing tool-governance behavior
- changing replay/WAL semantics
- introducing a planner, workflow controller, or hidden recovery state machine
- redesigning `workflow_status`, `optimization_continuity`, or
  `skill_promotion` in the same change
- changing public CLI/channel command semantics as part of the first pass

## Why This Refactor Is Worth Doing Now

This refactor is justified by three independent reasons.

### 1. It improves architecture without widening product scope

The repository already follows the correct subtraction principle at the product
level:

- no hidden planner
- no workflow-owned kernel
- no cognition-driven wake heuristics

That makes experience-ring decomposition a high-leverage next step. It improves
maintainability without reopening settled product debates.

### 2. It reduces regression risk at the busiest integration seams

Both target files sit at high-traffic boundaries:

- channel ingress to agent execution
- hosted lifecycle to model-visible context

These are the exact places where large files become expensive:

- they absorb unrelated changes
- they encourage incidental coupling
- they force broad mental reloads for small edits

### 3. It creates room for later compression without forcing it now

The repository should preserve valuable concepts such as:

- channel orchestration
- capability disclosure
- workflow posture
- deliberation continuity

But some of those surfaces are likely to be compressed later.
That compression will be safer if the current orchestration layer is already
split into narrower modules.

In short:

`decomposition first, compression second`

## Decision Options

### Option A: Leave both files mostly as-is

Pros:

- no short-term churn
- no migration work

Cons:

- keeps the two largest experience-ring hotspots intact
- keeps test seams broad
- makes future compression work riskier because orchestration remains tangled

### Option B: Extract helpers only

Pros:

- low migration cost
- preserves current code flow

Cons:

- tends to create utility fragments instead of real boundaries
- often leaves orchestration ownership unclear
- usually does not materially improve reviewability

### Option C: Contract-preserving decomposition around internal adapters

Pros:

- narrows ownership without changing runtime contracts
- improves testability and change isolation
- creates stable internal seams for later compression

Cons:

- requires deliberate migration sequencing
- may temporarily increase file count and internal interfaces

### Recommended Option

Choose **Option C**.

This RFC does not justify a public contract change. It does justify an internal
architecture change.

## Recommended Design

## Part 1: Decompose `channels/host.ts`

### Design Goal

Keep `runChannelMode(...)` as the channel-mode entrypoint, but reduce it to a
composition root for narrower channel adapters.

### Target Responsibility Split

The current file should be decomposed into five internal areas.

State ownership matters more than code motion here.
The current risk is not only that the file is large. It is that multiple code
paths currently share mutable closure state.

The decomposition must therefore assign clear ownership for each mutable map or
set before extracting modules.

### State Ownership Matrix

| State                                  | Owner                                       | Other modules' access                                              |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `sessions` / `sessionByAgentSessionId` | session coordinator                         | read-only query interface only                                     |
| `createSessionTasks`                   | session coordinator                         | private                                                            |
| `scopeQueues`                          | turn dispatcher                             | private                                                            |
| `pendingUpdateReservations`            | update-lock helper under the control router | private                                                            |
| `lastTurnByScope`                      | turn dispatcher                             | read-only query interface for control-router and A2A-related reads |
| `nextControllerSequenceByScope`        | reply writer                                | private                                                            |
| `shuttingDown`                         | bootstrap/composition shell                 | read-only flag passed to dispatcher and session coordinator        |

Ownership rule:

- the owner module is the only module allowed to mutate the state directly
- non-owner modules may only consume read-only query methods or narrow commands
- if two extracted modules still mutate the same map, the decomposition has not
  actually reduced coupling

#### A. Channel bootstrap and transport wiring

Own:

- supported-channel resolution
- transport / bridge launcher setup
- webhook and polling bootstrap assembly

Do not own:

- session lifecycle
- command handling
- turn dispatch policy

Suggested module direction:

- `channel-bootstrap.ts` under the existing `packages/brewva-gateway/src/channels/`
  directory

#### B. Session and runtime coordination

Own:

- session lookup and creation
- runtime retention / release
- idle eviction and capacity reclaim
- conversation binding and scope lookup

Do not own:

- command parsing
- controller reply formatting
- per-turn dispatch logic

Suggested module direction:

- `channel-session-coordinator.ts` under the existing
  `packages/brewva-gateway/src/channels/` directory

#### C. Control command routing

Own:

- slash-command handling
- focus / agent CRUD / inspect / insights / questions / update routing
- update-lock reservation logic

Do not own:

- transport send logic
- direct prompt execution mechanics

Suggested module direction:

- `channel-control-router.ts` and `channel-update-lock.ts` under the existing
  `packages/brewva-gateway/src/channels/` directory

Relationship to existing modules in the first pass:

- `command-router.ts` remains the text-to-command parser
- `operator-actions.ts` remains the small action-resolution helper
- `coordinator.ts` remains the multi-agent fanout / discuss / A2A executor
- `channel-control-router.ts` is the extracted command execution layer from the
  current `handleCommand(...)` body in `host.ts`

In other words:

- parsing stays where it is
- multi-agent execution stays where it is
- the new control router owns per-command execution logic, ACL enforcement,
  update-lock interaction, and controller-reply decisions

#### D. Inbound turn queueing and dispatch

Own:

- WAL enqueue / inflight / done / failed flow
- scope queue serialization
- fallback routing to the focused agent
- dispatch to agent sessions

Do not own:

- command parsing details
- runtime creation policy details

Suggested module direction:

- `channel-turn-dispatcher.ts` under the existing
  `packages/brewva-gateway/src/channels/` directory

#### E. Controller and outbound replies

Own:

- controller reply formatting
- outbound assistant/tool turn delivery
- command result reply normalization

Do not own:

- command policy
- queue ownership

Suggested module direction:

- `channel-reply-writer.ts` under the existing
  `packages/brewva-gateway/src/channels/` directory

### What Must Stay Stable

The first pass must preserve:

- `runChannelMode(...)` as the public entrypoint
- existing channel commands and routing behavior
- current update-lock semantics
- current `AgentRegistry` and `AgentRuntimeManager` semantics
- current WAL ordering and failure behavior
- current event names and payload semantics unless a separate RFC changes them

### Migration Shape

#### Phase 1

Extract pure helpers and data carriers without changing the control path.

Examples:

- reply normalization
- update reservation state
- outbound send wrappers

#### Phase 2

Extract ownership modules with narrow inputs/outputs:

- session coordinator
- control router
- turn dispatcher

Keep `runChannelMode(...)` as an explicit composition shell.

Important note:

the control router is still likely to be the largest extracted unit.
If it remains too large after the initial extraction, follow-up splitting into
per-command handlers is allowed, but not required for the first pass.

#### Phase 3

Move channel-specific bootstrap into a dedicated bootstrap module and leave
`runChannelMode(...)` as a short orchestration entrypoint.

### Expected Extraction Profile

Approximate first-pass size targets:

| Module                      | Current concentration                           | Expected first-pass size |
| --------------------------- | ----------------------------------------------- | ------------------------ |
| channel bootstrap           | transport/bootstrap-heavy regions in `host.ts`  | ~150-200 lines           |
| session coordinator         | session creation, reuse, retention, eviction    | ~200-280 lines           |
| control router              | current command execution body                  | ~450-550 lines           |
| turn dispatcher             | queueing, WAL, fallback routing, agent dispatch | ~300-400 lines           |
| reply writer                | controller replies and outbound send helpers    | ~100-150 lines           |
| remaining composition shell | wiring and assembly only                        | ~150-250 lines           |

The point is not to make every extracted module small.
The point is to make each module own one operational concern and one state
surface.

### Realized Topology After Promotion

The promoted implementation ended up with the same ownership split as this RFC,
plus a few narrower sub-adapters inside Part 1:

- `channel-bootstrap.ts`
- `channel-session-coordinator.ts`
- `channel-session-queries.ts`
- `channel-control-router.ts`
- `channel-turn-dispatcher.ts`
- `channel-agent-dispatch.ts`
- `channel-reply-writer.ts`
- `channel-host-lifecycle.ts`
- `channel-a2a-adapter.ts`

This is not a scope expansion.
It is the realized form of the same decomposition strategy:

- query/read-model concerns moved out of the session owner
- direct prompt execution moved out of the dispatcher/control path
- shutdown/recovery orchestration moved out of the composition shell
- A2A instrumentation moved out of inline host wiring

The canonical behavior map therefore lives in the narrower ownership modules
above, with `host.ts` acting as the composition entrypoint.

### What Success Looks Like

- `host.ts` becomes a thin composition file instead of the implicit behavior map
- most command-path tests can target the control router without constructing the
  full channel loop
- most dispatch-path tests can target queue/WAL behavior without command logic

## Part 2: Decompose `runtime-plugins/context-transform.ts`

### Design Goal

Keep the hosted context lifecycle contract unchanged, but split the
implementation into explicit sub-adapters.

Priority note:

Part 2 is a follow-up to Part 1, not a co-equal blocker.
It is still worth doing, but its expected payoff is lower because the current
file is much smaller and its internal state surface is narrower.
This means Part 2 may land:

- immediately after Part 1, if momentum is good, or
- as a follow-up series once Part 1 stabilizes

### Target Responsibility Split

#### A. Lifecycle adapter shell

Own:

- lifecycle hook registration
- conversion between runtime plugin API hooks and internal adapter calls

Do not own:

- compaction orchestration
- context composition policy
- telemetry formatting

Suggested module direction:

- `hosted-context-lifecycle.ts` under the existing
  `packages/brewva-gateway/src/runtime-plugins/` directory

#### B. Compaction controller

Own:

- gate state by session
- auto-compaction watchdog
- idle-vs-active compaction policy
- lifecycle reactions for `turnStart`, `context`, `sessionCompact`,
  `sessionShutdown`

Do not own:

- capability view
- context composition
- before-agent-start injection payload assembly

Suggested module direction:

- `hosted-compaction-controller.ts` under the existing
  `packages/brewva-gateway/src/runtime-plugins/` directory

Naming rationale:

the repository already has runtime-kernel services named
`context-compaction.ts` and `context-pressure.ts`.
The hosted adapter layer should therefore carry an explicit `hosted-` prefix so
grep and code navigation keep kernel services separate from experience-ring
adapters.

#### C. Injection pipeline

Own:

- resolve admitted runtime context
- assemble supplemental blocks
- run context composition
- return the final hidden message payload

Do not own:

- lifecycle hook registration
- compaction watchdog state

Suggested module direction:

- `hosted-context-injection-pipeline.ts` under the existing
  `packages/brewva-gateway/src/runtime-plugins/` directory

#### D. Context telemetry emitter

Own:

- `context_compaction_*` events
- `context_composed` event
- small helper payload builders for runtime plugin lifecycle telemetry

Do not own:

- lifecycle decisions
- composition policy

Suggested module direction:

- `hosted-context-telemetry.ts` under the existing
  `packages/brewva-gateway/src/runtime-plugins/` directory

### What Must Stay Stable

The first pass must preserve:

- the current hosted lifecycle hook names and timing
- the `beforeAgentStart` return shape
- compaction gate behavior and required-action semantics
- current interaction with `applyContextContract(...)`
- current interaction with `composeContextBlocks(...)`
- delegation-outcome surfacing semantics

### Migration Shape

#### Phase 1

Extract telemetry and gate-state helpers first.

This reduces file size without changing orchestration ownership yet.

#### Phase 2

Extract the compaction controller and move `context(...)`,
`sessionCompact(...)`, and `sessionShutdown(...)` orchestration behind a narrow
controller interface.

#### Phase 3

Extract the before-agent-start injection pipeline into a dedicated adapter.

At that point, `createContextTransformLifecycle(...)` should mainly:

- create dependencies
- assemble controllers
- return the lifecycle implementation object

### Expected Extraction Profile

Approximate first-pass size targets:

| Module                            | Expected first-pass size |
| --------------------------------- | ------------------------ |
| hosted context lifecycle shell    | ~60-100 lines            |
| hosted compaction controller      | ~150-220 lines           |
| hosted context injection pipeline | ~200-300 lines           |
| hosted context telemetry          | ~80-140 lines            |

This is still a useful refactor, but it is intentionally secondary to Part 1.

### What Success Looks Like

- compaction policy can be tested without constructing the whole before-start
  injection flow
- before-start context assembly can be tested without watchdog state
- telemetry policy can change without reopening orchestration code

## Risks And Mitigations

### Risk 1: Accidental contract drift

Mitigation:

- preserve public entrypoints
- preserve event names in the first pass
- use golden-path tests around command routing and context injection payloads

### Risk 2: Over-decomposition into meaningless helpers

Mitigation:

- extract only ownership-bearing modules
- prefer modules with one operational reason to change
- avoid utility-only churn unless it supports a real ownership split

### Risk 3: Recreating a hidden planner through new control abstractions

Mitigation:

- keep all new modules experience-ring adapters only
- do not move policy authority out of runtime kernel services
- do not add stage machines, routing heuristics, or autonomous recovery logic

## Source Anchors

- `packages/brewva-gateway/src/channels/host.ts`
- `packages/brewva-gateway/src/channels/command-router.ts`
- `packages/brewva-gateway/src/channels/coordinator.ts`
- `packages/brewva-gateway/src/channels/operator-actions.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/index.ts`
- `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`
- `docs/reference/runtime-plugins.md`
- `docs/journeys/operator/channel-gateway-and-turn-flow.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`

## Validation Signals

- `runChannelMode(...)` behavior remains covered for:
  - command routing
  - focus / CRUD paths
  - update lock behavior
  - queue ordering and WAL state transitions
  - runtime eviction and session reuse
- context lifecycle behavior remains covered for:
  - gate-required before-start path
  - injection-accepted before-start path
  - auto-compaction request / complete / fail paths
  - delegation-outcome surfacing
  - `context_composed` telemetry
- documentation and code continue to reflect:
  - no hidden planner
  - no widened kernel authority
  - one canonical hosted pipeline

## Promotion Criteria

Promote this RFC when all of the following are true:

1. `channels/host.ts` is reduced to a clear composition entrypoint and the new
   ownership modules are the real behavior homes.
2. `runtime-plugins/context-transform.ts` is reduced to a lifecycle adapter
   shell with separate compaction, injection, and telemetry modules.
3. Public hosted session, runtime-plugin, and channel command contracts remain
   behaviorally stable.
4. The stable docs describe the narrower ownership model instead of pointing at
   monolithic implementation files as the primary behavior map.
5. Each extracted ownership module has at least one narrowly-scoped contract
   test that exercises its boundary without requiring the full channel bootstrap
   loop or the full hosted lifecycle stack.

## Follow-Up

This RFC intentionally stops at decomposition.

It does **not** decide the next compression steps for:

- workflow artifact taxonomy
- capability-view detail level
- default deliberation-context injection policy

Those should remain separate follow-up decisions once the experience-ring
implementation is easier to reason about.
