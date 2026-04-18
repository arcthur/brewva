# Design Axioms

Brewva's kernel is defined by one constitutional line:

`Intelligence proposes. Kernel commits. Tape remembers.`

Implementation-grade reading:

`Intelligence explores. Kernel authorizes effects. Tape remembers commitments.`

This document fixes the architectural taste behind that line so new features
can be judged against a stable standard instead of local convenience.
It defines authority precedence and architectural taste, not method-level
public contracts.

## Axioms

1. `Adaptive logic stays out of the kernel.`
   Retrieval ranking, artifact curation, summarization, and any optional path
   helpers belong to deliberation/control-plane layers.
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
12. `Public width should compress toward authority width.`
    Runtime may expose explicit inspection, recovery, or maintenance helpers,
    but the default host and extension contract should stay anchored to the
    smallest authority-facing layer that preserves effect governance, replay,
    verification, and rollback semantics.
13. `Kernel contracts admit only correctness-bearing judgments.`
    If a wrong judgment would not change replay correctness, approval truth,
    rollback correctness, or recovery correctness, it does not belong in the
    kernel contract.
14. `Platform growth stays opt-in until multi-agent semantics mature.`
    New orchestration breadth must land as opt-in control-plane behavior or as
    an explicit exception with a compatibility story. The current stable
    transaction boundary remains `single tool call`.

Implementation note:

- runtime authority centers on effect classes, approval requirements, and
  receipt-bearing rollback
- substrate owns how the agent loop runs: session lifecycle, turn orchestration,
  tool execution phases, prompt/context resource loading, and session
  persistence
- hosted, CLI, and channel execution surfaces should converge on the same
  substrate rather than maintaining separate runtime-shaped compatibility shells
- Pi compatibility may survive as import/export and reference material, but not
  as an execution-path dependency
- repository-level change fitness may consume runtime evidence, but it remains
  a separate judgment structure from runtime commitment authority
- runtime may persist objective iteration facts such as metric observations,
  guard results, and any future evidence-bound protocol facts, but those facts
  remain durable evidence rather than a runtime-owned optimizer
- repository-native compound knowledge belongs in `docs/solutions/**` plus
  explicit retrieval and maintenance surfaces, not in a widened
  `runtime.knowledge.*` authority surface
- reviewer ensembles may exist behind stable public review contracts, but they
  remain advisory control-plane behavior rather than kernel-owned merge
  authority
- visible tool surface and execution hints still shape exploration, but they do
  not define authority on their own
- public runtime breadth does not by itself make every domain equally
  kernel-central; rich inspection and recovery surfaces may stay explicit
  without becoming the default coupling layer for hosts, skills, or plugins
- explicit control-plane exemptions may exist, but they must stay narrow and
  auditable
- the current stable authority-bearing transaction boundary is `single tool
call`; turn-level bounded recovery may grow later, but cross-agent saga
  semantics, generalized compensation graphs, and default-path partial-failure
  repair are not part of the current stable contract
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
  - evidence-backed artifact folding and retrieval
  - deliberation memory, recall broker, curation, promotion, and continuity products
  - optional search or delegation assistance outside kernel authority
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

State visibility rule:

`Behavior-changing state should be replay-derived. Visibility-changing state should be projection-visible. Performance-only state may remain local.`

## Kernel Admission Rules

The kernel may:

- validate contracts
- accept, reject, or defer proposals
- arm gates
- create replayable state transitions
- emit receipts and tape evidence

The kernel may not:

- silently invent proposals on behalf of missing deliberation layers
- perform adaptive ranking or path orchestration inside the commitment path
- treat lossy summaries as authoritative state
- hide commitment reasons behind opaque heuristics

## Package Realization

The ring model matters more than package count. A package split is useful only
when it protects authority boundaries instead of hiding them.

Practical boundary rule:

- if a concern decides how a turn runs, it belongs to the substrate
- if a concern decides whether an effect may commit, it belongs to the kernel
- the runtime contract stays narrow even when the substrate grows more capable

## Related Docs

- `docs/architecture/system-architecture.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime.md`
- `docs/reference/proposal-boundary.md`
