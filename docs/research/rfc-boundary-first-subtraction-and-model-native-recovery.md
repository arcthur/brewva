# Research: Boundary-First Subtraction and Model-Native Recovery

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-03-20`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`

## Direct Conclusion

Brewva should simplify by subtraction, not by feature gating.

The runtime and default product path should keep only what remains valuable as
models become stronger and context windows become larger:

- system boundaries
  - effect authorization
  - durability and replay
  - rollback and recovery
  - verification evidence
  - cost and resource ceilings
- model-native recovery support
  - concise turn briefs
  - verification surfaces
  - repair evidence and rollback anchors

Brewva should remove control-plane layers that primarily compensate for weaker
models by deciding what the model should do next.

That means the project should prefer deletion over compatibility switches for:

- skill brokerage and judge-based preselection
- exploration supervision and trust scoring
- runtime-owned skill cascade orchestration
- proactive wake heuristics driven by cognition signals
- large state-machine debugging loops that prescribe review and repair order

The design goal is not a thinner kernel for its own sake. The goal is a cleaner
split:

- kernel records and governs effects
- the model chooses paths
- recovery remains first-class because stronger models still make mistakes

## Problem Statement And Scope

Recent refactors improved boundary clarity, package ownership, and replay
semantics. They did not change the default product posture enough. Brewva still
ships a broad control plane that makes too many path decisions on the model's
behalf.

That broad control plane creates four problems:

1. The default mental model is too wide
   - new contributors must understand runtime, gateway, plugins, routing,
     cascade, debug-loop, and cognition subsystems before the product feels
     legible
2. The runtime and default host path still carry model-compensation logic
   - these layers age poorly as models improve
3. Compatibility switches preserve dead design
   - code stays harder to reason about even after the product has moved on
4. The architecture has no hard rule that prevents the same pattern from
   growing back later

This RFC covers:

- the principle for deciding what belongs in the kernel and default path
- the removal policy for model-compensation layers
- the reduced target architecture
- the implementation posture for future simplification work

This RFC does not weaken:

- effect governance
- replay and WAL
- auditability
- rollback and repair evidence
- verification
- cost and resource boundaries

## Design Principles

### 1. Track System Boundaries, Not Model Compensation

Runtime complexity should track boundaries that remain real regardless of model
quality:

- who is allowed to perform an effect
- what changed
- how that change can be replayed or rolled back
- what evidence exists for success or failure
- how much cost or resource budget remains

If a subsystem mainly exists to predict or prescribe the next cognitive step,
it does not belong in the kernel or default host path.

### 2. Stronger Models Reduce Path Prescription, Not the Need for Recovery

Better models reduce the value of:

- brokered skill selection
- heuristic routing
- trust scores
- path state machines
- exploratory guardrails that try to coach the model

Better models do not remove the need for:

- review
- verification
- rollback
- repair context
- failure evidence

Review and repair are not weak-model compensation. They are part of working in
an open world with side effects, imperfect tools, and changing repositories.

### 3. Remove, Do Not Toggle

When Brewva classifies a subsystem as model compensation, the default action is
deletion.

The project should not preserve removed behavior through:

- dormant config switches
- shadow profiles
- compatibility wrappers
- no-op adapters
- event families retained only for continuity

If a removed field or tool still appears in configuration or operator flow, the
system should fail fast with a precise migration error instead of silently
accepting dead options.

### 4. Keep One Default Path

The default product path should stay narrow:

`CLI -> hosted session -> effect gate -> governed tools -> tape/WAL -> verification/repair`

Channels, scheduler flows, and other adapters may still exist, but they should
attach to the same reduced path instead of reintroducing separate cognitive
machinery.

### 5. Tape Is Commitment Memory

Tape should remember durable commitments, approvals, rollback anchors,
verification outcomes, and recovery-critical session facts.

Tape should not serve as a general-purpose bus for cognition telemetry,
selection traces, or planner-oriented control signals.

### 6. Briefs Are Allowed; Scripted Cognition Is Not

Brewva may shape model context into a concise turn brief. That remains valuable
even with larger context windows because attention is still scarce.

Brewva should not use that layer to script the path:

- no hidden chain planner
- no mandatory next-step routing
- no state machine that decides review-before-repair or repair-before-review

## Decision Tests

Every candidate subsystem should be classified with these tests.

### Boundary Test

Keep the subsystem in the kernel or default path if removing it would weaken:

- effect authorization
- durability or replay
- rollback or recovery guarantees
- verification evidence
- cost or resource enforcement

### Amplification Test

Keep or rewrite the subsystem if it helps stronger models recover from mistakes
without deciding the path for them.

Examples:

- verification surfaces
- rollback receipts
- repair-oriented diff summaries
- concise turn briefs

### Compensation Test

Delete the subsystem if it mainly decides what the model should do next inside
the turn.

Examples:

- broker chooses skill
- runtime chooses chain
- heuristic trust score changes routing behavior
- runtime blocks or reshapes exploration because it predicts the model is
  wasting time

## Options Considered

### Option A: Keep Current Architecture And Add More Switches

Approach:

- preserve current subsystems
- add profiles and flags to disable parts of the stack

Pros:

- lower short-term migration cost
- easier staged rollout

Cons:

- dead design remains in code, config, docs, and tests
- the default mental model stays wide
- removed ideas tend to regrow behind compatibility layers

### Option B: Preserve Subsystems But Default Them Off

Approach:

- keep broker, cascade, trust, and proactivity
- move them behind non-default profiles

Pros:

- smaller default user experience
- fewer immediate deletions

Cons:

- architecture still treats those subsystems as first-class
- future contributors keep paying the design cost
- "optional" often becomes "quietly supported forever"

### Option C: Boundary-First Subtraction

Approach:

- delete model-compensation layers
- keep and strengthen review, verification, rollback, and replay
- update docs, contracts, and package ownership to match the smaller design

Pros:

- matches the long-term model trajectory
- makes the kernel legible again
- leaves a clean rule for future work

Cons:

- larger near-term breaking change
- some current control-plane behavior disappears immediately

## Chosen Direction

Option C.

The project should simplify by removing model-compensation layers from the code
base, not by adding feature flags around them.

## Proposed Architecture

### Kernel Responsibilities

`@brewva/brewva-runtime` should continue to own:

- effect authorization and governance
- replay, event tape, and WAL recovery
- rollback receipts and mutation journals
- verification evaluation and evidence recording
- cost tracking and resource ceilings
- deterministic context admission and hard safety limits
- task and truth state that affect durable execution or recovery

### Product Responsibilities

The default host path should expose:

- governed tools
- concise context or turn-brief assembly
- verification and repair primitives
- approval and rollback interactions

The default host path should not expose runtime-owned planning machinery that
chooses the next step on behalf of the model.

### Recovery Responsibilities

Recovery remains first-class and should get better, not thinner.

Brewva should preserve and improve:

- `verify` or verification tool surfaces
- rollback anchors and mutation journals
- failure evidence attached to tool results or verification outcomes
- repair-oriented summaries that help the model fix the last attempt

Brewva should remove recovery state machines that prescribe the order of
analysis, implementation, review, and retry.

## Immediate Subtractions

The current direction should remove the following subsystems and their public
contracts instead of hiding them behind switches.

### 1. Delete Skill Brokerage As A Core Product Layer

Remove:

- `@brewva/brewva-skill-broker`
- judge-based skill preselection
- routing traces whose primary audience is model path selection

Skills may still exist as static operator-authored recipes or contracts, but
the runtime should not broker or judge them on the model's behalf.

### 2. Delete Exploration Supervision And Trust Scoring

Remove:

- `ExplorationSupervisorService`
- `TrustMeterService`
- exploration or routing adjustments driven by session-local trust heuristics

The runtime may still expose facts such as tool results, verification outcomes,
and token usage. It should not turn those facts into path-prescribing logic.

### 3. Delete Runtime-Owned Skill Cascade Orchestration

Remove:

- `SkillCascadeService`
- chain-control tools that exist only to manage runtime-owned path state
- event families whose purpose is to preserve skill-chain control flow

If a workflow needs "analyze, then implement, then review," the model should
choose that sequence directly.

### 4. Delete Proactive Wake Heuristics That Depend On Cognition Signals

Remove:

- proactive wake planning driven by memory summaries, internal adaptation
  signals, or control-plane heuristics

Only retain wake or resume logic that is attached to an external system
boundary such as an explicit schedule, operator action, or incoming channel
event.

### 5. Replace Posture Taxonomy With A Smaller Effect Gate

Reduce the public execution model to:

- `safe`
- `effectful`

`rollbackable` remains important, but it should live as effect metadata and
receipt semantics rather than as a third planning-visible execution lane.

### 6. Replace Large Debugging State Machines With Verification And Repair Primitives

Remove:

- state-machine debugging loops that encode phase transitions and retry policy

Retain:

- verification reports
- failure evidence
- rollback anchors
- repair-oriented context summaries

### 7. Replace Adaptive Context Orchestration With A Brief Compiler

Remove:

- adaptive or trust-driven context shaping that mainly tries to steer the
  model's path

Retain:

- deterministic admission
- hard safety limits
- concise turn-brief assembly

## Package Direction

The target package shape is smaller than the current product surface.

The default long-lived packages should be:

```text
packages/
  brewva-runtime
  brewva-tools
  brewva-cli
  brewva-gateway
  brewva-channels-*
```

Package-level rule:

- packages that exist mainly to decide the model's next path do not have a
  protected future
- packages that survive must justify themselves in terms of governance,
  durability, verification, recovery, or operator integration

## Source Anchors

Current pressure points and removal candidates:

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
- `packages/brewva-runtime/src/services/proposal-admission.ts`
- `packages/brewva-runtime/src/events/event-types.ts`
- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `packages/brewva-gateway/src/runtime-plugins/index.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`

## Risks And Tradeoffs

### Risk 1: Some Sessions May Lose Near-Term Guidance

Removing broker and cascade layers may reduce convergence for weaker models or
poorly specified tasks.

Why the tradeoff is acceptable:

- Brewva should optimize for the long-term model trend
- guidance that remains valuable should be recast as static recipe context or
  recovery evidence, not runtime path control

### Risk 2: Existing Operators May Depend On Removed Controls

Some workflows may rely on current command, event, or config surfaces.

Mitigation:

- fail fast on removed config
- document migrations plainly
- remove dead surfaces completely instead of leaving half-supported shadows

### Risk 3: Over-correcting Could Weaken Recovery

A blunt subtraction pass could accidentally remove evidence and repair support
along with orchestration.

Mitigation:

- treat review and repair as amplification, not compensation
- require rollback, verification, and repair evidence to stay intact or get
  stronger during subtraction work

## Validation Signals

The direction is working if Brewva shows these signals after subtraction work:

- fewer runtime and gateway concepts in the default session path
- fewer event families in the authority log
- fewer config fields and profile branches
- no runtime-owned routing, trust, or chain-control state in the default path
- review and repair still work through explicit verification, rollback, and
  repair evidence
- operator docs become shorter without weakening safety explanations

## Promotion Criteria

Promote this RFC when all of the following are true:

1. Stable architecture docs adopt the boundary-first subtraction rule.
2. Removed subsystems do not survive behind compatibility switches.
3. The default hosted session path no longer imports or wires broker, trust,
   cascade, or cognition-driven proactivity layers.
4. Runtime and tool docs describe recovery as explicit primitives rather than
   path state machines.
5. Tape and event docs make commitment memory the stable rule.
