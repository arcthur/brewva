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

## Context Model

Context injection is single-path and deterministic:

- governed source registration
- arena planning
- global budget clamp
- hard-limit compaction gate

Projection and arena are not parallel memories:

- projection provides one deterministic working snapshot
- arena plans which sources fit the current turn

Model-facing composition is separate:

- runtime admission decides which sources are allowed
- `ContextComposer` decides how admitted blocks are shown to the model
- default hosted-session behavior is narrative-first

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
