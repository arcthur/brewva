# Cognitive Product Architecture

This document describes Brewva's product-facing cognitive shape without
changing the constitutional line:

`Intelligence proposes. Kernel commits. Tape remembers.`

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

## Exploration Lane And Commitment Lane

The product still distinguishes two lanes.

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

This plane may read kernel state, but it does not mutate kernel state directly.

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
