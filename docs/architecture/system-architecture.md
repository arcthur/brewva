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
  - planning
  - ranking
  - sequencing
  - delegation decisions
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
  - future planners

Rings define authority. Planes define product behavior.

Boundary note:

- rings outrank planes when authority is in question
- naming a plane does not create new authority by itself
- planes may explain presentation or orchestration, but they must not be used
  to justify hidden stage machines, default injected lane briefs, or
  model-writable control state

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

## State Taxonomy

| Category                 | Role                                                           | Authority                    | Typical carriers                                     |
| ------------------------ | -------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `Kernel Commitments`     | authoritative system commitments                               | authoritative                | tape, receipts, task, truth, ledger                  |
| `Working State`          | session-local working view and injection planning              | non-authoritative            | projection, context arena, active tool surface       |
| `Deliberation Artifacts` | non-kernel planning and operator sediment                      | non-authoritative            | operator notes, schedule prompts, delegation packets |
| `Tool Surface`           | turn-visible action surface                                    | policy-governed              | base tools, skill-scoped tools, operator tools       |
| `Control Plane`          | scheduling, ranking, delegation, operator-facing orchestration | non-authoritative by default | schedulers, wake prompts, child-run controllers      |

Important distinctions:

- projection is working state, not long-term memory
- workflow artifacts/posture are derived working-state views, not new
  commitment-memory event families
- session-scoped workflow posture is not repository merge or release
  authority
- iteration facts are durable event evidence for model-native optimization
  loops, not a runtime-owned optimizer state machine
- context arena is an injection planner, not a memory system
- tool surface should reflect the current commitment boundary, not the whole
  static capability catalog

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
- turn WAL

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
- arena planning
- global budget clamp
- hard-limit compaction gate

Projection and arena are not parallel memories:

- projection provides one deterministic working snapshot
- arena plans which sources fit the current turn
- working projection and `workflow_status` read from durable events and working
  state, but they remain explicit/advisory rather than prescribing a path

Model-facing composition is separate:

- runtime admission decides which sources are allowed
- `ContextComposer` decides how admitted blocks are shown to the model
- default hosted-session behavior is narrative-first
- the model may choose any valid path unless an independent governance boundary
  blocks it

## Tool Surface

The runtime/extension stack treats tool surface as three layers:

- `base tools`
- `skill-informed tools`
- `operator tools`

Visible surface helps the model understand available paths, but authority sits
on effect classes, approval requirements, rollbackability, and resource ceilings.

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
- raw runtimes without a governance port fail closed at the approval boundary

This preserves the kernel promise: the kernel governs execution, but adaptive
selection logic stays outside the core path.

External repository-fitness systems may still interact with Brewva through host
policy, explicit tools, or imported evidence. That integration should feed the
runtime as external judgment input rather than expanding the kernel into a
repository merge controller.
