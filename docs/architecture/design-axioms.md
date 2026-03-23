# Design Axioms

Brewva's kernel is defined by one constitutional line:

`Intelligence proposes. Kernel commits. Tape remembers.`

Implementation-grade reading:

`Intelligence explores. Kernel authorizes effects. Tape remembers commitments.`

This document fixes the architectural taste behind that line so new features
can be judged against a stable standard instead of local convenience.

## Axioms

1. `Adaptive logic stays out of the kernel.`
   Ranking, planning, summarization, and heuristic inference belong to
   deliberation/control-plane layers.
2. `Subtraction beats switches.`
   When a control-plane layer stops earning its keep, delete it from the
   default product path instead of hiding it behind a compatibility toggle.
3. `Govern effects, not thought paths.`
   Kernel authority should constrain what may happen to the world, not prescribe
   the exact reasoning path intelligence must take.
4. `Every commitment has a receipt.`
   Accept/reject/defer decisions must remain inspectable after the turn that
   produced them.
5. `Tape is commitment memory.`
   The event tape is replayable memory for what the system actually committed.
6. `Inconclusive is honest governance.`
   The system must be able to say "not enough evidence yet" without collapsing
   into a fake pass/fail binary.
7. `Graceful degradation beats hidden cleverness.`
   If a deliberation path fails, the kernel must stay safe and explainable.
8. `Resource expansion is negotiated, not assumed.`
   When a run needs more budget, the preferred answer is an explicit
   `resource_lease`, not hidden privilege escalation.
9. `Recovery is model-native, not kernel choreography.`
   Review, verify, repair, and retry remain first-class product behavior, but
   runtime should provide primitives rather than a planner-shaped state machine.
10. `Repository governance stays adjacent to the kernel.`
    Merge or release trust for repository changes belongs to an adjacent
    repository-governance plane. The runtime may consume or emit evidence for
    that plane, but it should not silently absorb repository policy into kernel
    authority.
11. `Documentation hierarchy follows authority hierarchy.`
    Documents that describe product shape, orchestration flow, or operator UX
    must not silently widen kernel authority. When wording conflicts, the
    narrowest authority-defining document wins.

Implementation note:

- runtime authority centers on effect classes, approval requirements, and
  receipt-bearing rollback
- repository-level change fitness may consume runtime evidence, but it remains
  a separate judgment structure from runtime commitment authority
- runtime may persist objective iteration facts such as metric observations,
  guard results, and any future evidence-bound protocol facts, but those facts
  remain durable evidence rather than a runtime-owned optimizer
- visible tool surface and execution hints still shape exploration, but they do
  not define authority on their own
- explicit control-plane exemptions may exist, but they must stay narrow and
  auditable
- architecture prose about planes, lanes, prompts, or flow should be read as
  descriptive only unless it names a concrete invariant or public contract

## Ring Model

- `Kernel Ring`
  - commitment boundary
  - policy enforcement
  - tool/context/cost gates
  - verification
  - replay, WAL, recovery
- `Deliberation Ring`
  - planning
  - ranking
  - sequencing
  - future multi-model reasoning flows
- `Experience Ring`
  - CLI, gateway, channels
  - operator UX
  - lifecycle adapters

Rings are about authority, not package names.

## Plane Model

- `Working State Plane`
  - projection
  - context arena
  - active tool surface
- `Cognitive Product Plane`
  - context composition
  - persona/profile rendering
  - capability disclosure
- `Control Plane`
  - recovery
  - heartbeat
  - scheduling
  - delegation orchestration

Product rule:

`Model sees narrative. Operator sees telemetry. Kernel sees receipts.`

Additional rule:

`Deliberation searches for paths. Kernel judges effects.`

## Kernel Admission Rules

The kernel may:

- validate contracts
- accept, reject, or defer proposals
- arm gates
- create replayable state transitions
- emit receipts and tape evidence

The kernel may not:

- silently invent proposals on behalf of missing deliberation layers
- perform adaptive ranking inside the commitment path
- treat lossy summaries as authoritative state
- hide commitment reasons behind opaque heuristics

## Package Realization

The ring model matters more than package count. A package split is useful only
when it protects authority boundaries instead of hiding them.
