# Cognitive Product Architecture

This document describes Brewva's product-facing cognitive shape without
changing the constitutional line:

`Intelligence proposes. Kernel commits. Tape remembers.`

Interpretation rule:

- this document explains model-facing product behavior
- it does not redefine kernel authority or replay contracts
- if wording here conflicts with `design-axioms`, `invariants-and-reliability`,
  or `system-architecture`, those narrower authority documents win

Normative status:

- this file describes product-facing shape and presentation, not authority
- it must not be used as the sole justification for default-path injections,
  hidden phase logic, or durable control-state growth
- if the product shape changes, this file should be updated instead of being
  treated as an implicit contract expander

## Taxonomy

Brewva keeps two taxonomies separate:

- `Rings` define authority boundaries
- `Planes` define cross-cutting product concerns

### Rings

- `Kernel Ring`
  - authoritative commitments
  - effect authorization
  - verification, replay, WAL, receipts
- `Deliberation Ring`
  - planning
  - ranking
  - sequencing
  - delegation decisions
- `Experience Ring`
  - CLI
  - gateway
  - channels
  - operator UX

### Planes

- `Working State Plane`
  - projection
  - context arena
  - current visible tool surface
- `Cognitive Product Plane`
  - context composition for the model
  - persona/profile rendering
  - capability disclosure
  - recovery-facing presentation
- `Control Plane`
  - heartbeat
  - explicit wake triggers
  - scheduling triggers
  - delegation orchestration

## Core Principle

The product rule is:

`Model sees narrative. Operator sees telemetry. Kernel sees receipts.`

Consequences:

- kernel state remains authoritative and replayable
- operator telemetry does not become default model context
- model-facing context is composed from admitted sources, not raw dashboards
- review and repair remain product behavior without becoming kernel planning
- repository merge or release authority remains outside the default cognitive
  plane unless a host explicitly imports external fitness evidence

## Exploration Lane And Commitment Lane

The product still distinguishes two lanes.

These lanes are explanatory product language, not first-class runtime
authority objects. They must not be implemented as hidden stage machines or
default path prescriptions.

Concrete non-goals:

- default injected workflow lane briefs
- hidden phase resolution or required-next-step controllers
- runtime-owned convergence blockers that decide when exploration should stop
- model-writable durable hints that feed back into later control logic

### `exploration lane`

Responsibilities:

- discover paths
- choose tools
- decide when to verify, review, repair, or delegate
- negotiate more context or budget

Typical carriers:

- current prompt
- visible tool surface
- projection
- supplemental context
- delegation packets and child-run outcomes
- lease requests

### `commitment lane`

Responsibilities:

- authorize effects
- record receipts
- preserve replayable durability
- keep verification evidence durable

The point of separating the lanes is to keep the kernel from prescribing thought
paths while still enforcing safety.

## Cognitive Product Plane

The cognitive plane owns model-facing behavior that should not become kernel
authority.

Current responsibilities:

- `ContextComposer`
  - arranges admitted context into narrative, constraint, and diagnostic blocks
- `CapabilityView`
  - turns exact governance metadata into model-facing tool disclosure
- `PersonaProfile`
  - renders stable identity/workstyle signals from
    `packages/brewva-runtime/src/context/identity.ts`
- recovery presentation
  - exposes verification, rollbackability, approval requirements, and worker
    outcomes without prescribing the next step
- workflow inspection presentation
  - exposes explicit pull-based workflow surfaces such as `workflow_status`
    and working projection entries
  - summarizes derived workflow artifact signals and blockers without default
    turn-time injection
  - stays explicit and advisory-only instead of turning product UX into a hidden planner
- optimization protocol presentation
  - exposes objective iteration facts such as metric observations, guard
    results
  - keeps loop strategy and sequencing in the model-native layer rather than
    moving them into kernel authority

This plane may read kernel state, but it does not mutate kernel state directly.

## Workflow Inspection Surfaces

Workflow chaining is productized as an explicit inspection surface, not as a
new kernel authority object.

Current product surfaces:

- `workflow_status` as an explicit inspection tool
- working projection entries such as `workflow.discovery`, `workflow.strategy_review`,
  `workflow.design`, `workflow.review`, `workflow.qa`, `workflow.ship`,
  `workflow.iteration_metric`, and `workflow.iteration_guard`

These surfaces are derived from durable events and session state such as:

- `skill_completed` outputs
- verification outcome and write-mark events
- iteration fact events such as metric observations and guard results
- worker patch adoption or failure events
- pending delegated worker results

The product goal is visibility and recovery guidance. The product must not
convert those signals into a mandatory stage machine or a default injected lane
brief.

Interpretation reminder:

- these workflow surfaces may summarize session-local state
- they do not grant new authority to projection, context composition, or
  product-facing adapters

Those surfaces are also narrower than repository change fitness:

- `workflow_status`
- projection-level posture summaries
- session-derived `ship_posture`

They describe session-local advisory state. They do not declare that a
repository diff is approved to merge or ready to release.

## ContextComposer Boundary

`ContextComposer` is not a replacement for kernel admission.

Responsibilities:

- consume already-admitted context entries from `runtime.context.buildInjection(...)`
- classify them as `narrative`, `constraint`, or `diagnostic`
- order visible blocks for the turn
- emit composition metrics such as narrative ratio

Non-responsibilities:

- source registration
- source admission
- budget planning
- replay
- hidden planning hints

That split remains:

- runtime admission decides what may enter
- extensions shape how admitted context is shown
- the model decides what to do next

## Control-Plane Triggers

Heartbeat and schedule triggers are explicit control-plane prompts.

Current rule:

- operators author the trigger
- gateway opens or resumes the target session
- the model receives the explicit prompt
- no hidden wake plan or cognition-driven suppression layer sits in between

This keeps the boundary honest:

- control plane may schedule and deliver explicit prompts
- kernel authority is unchanged
