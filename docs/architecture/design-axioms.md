# Design Axioms

Brewva's current architecture is defined by one constitutional line:

`Model owns attention. Kernel owns consequence. Tape owns truth. Runtime owns physics.`

Implementation-grade reading:

`Model curates working memory. Kernel authorizes effects. Tape preserves
committed facts and compact baselines. Runtime enforces context-window, cache,
cost, provider, durability, and recovery constraints.`

This document fixes the architectural taste behind that line so new features
can be judged against a stable standard instead of local convenience.
It defines authority precedence and architectural taste, not method-level
public contracts.

## Axioms

1. `Attention belongs to the model.`
   The model decides what to read, remember, evict, recall, quote, or compact.
   Runtime may expose tools and physical status; it should not own salience.
2. `Adaptive logic stays out of the kernel.`
   Retrieval ranking, artifact curation, summarization, and any optional path
   helpers belong to deliberation/control-plane layers.
3. `Subtraction beats switches.`
   When a control-plane layer stops earning its keep, delete it from the
   default product path instead of hiding it behind a compatibility toggle.
4. `Govern effects, not thought paths.`
   Kernel authority should constrain what may happen to the world, not prescribe
   the exact reasoning path intelligence must take.
5. `Every commitment has a receipt.`
   Accept/reject/defer decisions must remain inspectable after the turn that
   produced them.
6. `Tape is commitment memory.`
   The event tape is replayable memory for what the system actually committed.
7. `Inconclusive is honest governance.`
   The system must be able to say "not enough evidence yet" without collapsing
   into a fake pass/fail binary.
8. `Graceful degradation beats hidden cleverness.`
   If a deliberation path fails, the kernel must stay safe and explainable.
9. `Resource expansion is negotiated, not assumed.`
   When a run needs more budget, the preferred answer is an explicit
   `resource_lease`, not hidden privilege escalation.
10. `Recovery is model-native, not kernel choreography.`
    Review, verify, repair, and retry remain first-class product behavior, but
    runtime should provide primitives rather than a planner-shaped state machine.
11. `Same evidence is not shared authority.`
    Operator, model, channel, and embedder surfaces should converge on shared
    evidence projections where practical, but approval, capability, sandbox,
    adoption, verification-gate, and kernel authority stay separate.
12. `Product loops are projections, not runtime state machines.`
    `receive -> orient -> authorize -> act -> verify -> continue` is product
    grammar over existing receipts and projections. It must not become a hidden
    planner, prompt choreography engine, or second session lifecycle owner.
13. `Repository governance stays adjacent to the kernel.`
    Merge or release trust for repository changes belongs to an adjacent
    repository-governance plane. The runtime may consume or emit evidence for
    that plane, but it should not silently absorb repository policy into kernel
    authority.
14. `Documentation hierarchy follows authority hierarchy.`
    Documents that describe product shape, orchestration flow, or operator UX
    must not silently widen kernel authority. When wording conflicts, the
    narrowest authority-defining document wins.
15. `Public width should compress toward authority width.`
    Runtime may expose explicit inspection, recovery, or maintenance helpers,
    but the default host and extension contract should stay anchored to the
    smallest authority-facing layer that preserves effect governance, replay,
    verification, and rollback semantics.
16. `Kernel contracts admit only correctness-bearing judgments.`
    If a wrong judgment would not change replay correctness, approval claim,
    rollback correctness, or recovery correctness, it does not belong in the
    kernel contract.
17. `Platform growth stays opt-in until multi-agent semantics mature.`
    New orchestration breadth must land as opt-in control-plane behavior or as
    an explicit exception with a compatibility story. The current stable
    transaction boundary remains `single tool call`.
18. `Descriptive metadata derives views, never authority.`
    Descriptions, selection hints, and in-body cross-references may be projected
    into documentation and advisory surfaces, but the runtime must never derive
    an unbypassable decision — a gate, an activation, or an authority grant —
    from them. Derivation is one-way: authoritative state may feed descriptive
    views; descriptive metadata may not feed authoritative runtime decisions.
    Advisory, model-bypassable ranking is the only exception and must be
    registered where it lives.

Implementation note:

- runtime authority centers on effect classes, approval requirements, and
  receipt-bearing rollback
- model-facing memory is a workbench: free-form notes, evictions, source refs,
  preserved quotes, and reversible edits until the next baseline
- product-facing inspection is a Work Card projection: it may summarize goal,
  context, options, authority, work, evidence, and continuation anchors, but it
  remains a view over existing owners
- attention options expose bounded candidate cards before unbounded content;
  consume, pin, ignore, and verify-plan actions are distinct effects with
  distinct authority posture
- substrate owns how the agent loop runs: session lifecycle, turn orchestration,
  tool execution phases, request materialization primitives, and session
  persistence; it does not execute model calls
- gateway owns the model-call boundary for main turns, compaction, model
  routing, provider cache policy, and usage accounting — this is the model-call
  implementation face of the `Runtime Physics Boundary` ring; turn-execution
  truth (provider streaming, retry, terminal commit) stays owned by `runtime.turn`
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
  not define authority on their own and must not become hidden path gates
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

Rings refine the four-owner constitution (`Model / Kernel / Tape / Runtime`) into
authority detail — they are an explanatory layer beneath those four owners, not a
top-level axis. This is the authority-bearing view of the ring topology. The
canonical, complete ring list — which adds the implementation rings
`Substrate Ring`, `Model Attention Boundary`, and `Control Plane` — lives in
`docs/architecture/system-architecture.md`. The two are consistent: the rings
below are the authority-bearing subset of that topology.

- `Kernel Ring`
  - commitment boundary
  - policy enforcement
  - tool, approval, verification, budget, and hard context-window gates
  - replay, WAL, recovery
- `Runtime Physics Ring`
  - context status
  - cache and cost accounting
  - provider request constraints
  - durability classes
- `Runtime Physics Boundary`
  - main turn model calls
  - LLM-driven compaction
  - model routing
  - provider cache policy
- `Deliberation Ring`
  - candidate generation
  - recall search and precedent retrieval
  - compact prompt templates
  - optional search or delegation assistance outside kernel authority
- `Experience Ring`
  - CLI, gateway, channels
  - operator UX
  - lifecycle adapters

Rings are about authority, not package names.

## Projections, Not Planes

Planes are read-only projections of rings, not a parallel coordinate system.
The full ring topology and its projection column live in
`docs/architecture/system-architecture.md`.

Product rule:

`Model sees workbench and options. Operator sees work cards. Kernel sees receipts.`

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

- if a concern executes a model call, it belongs to the gateway model boundary
- if a concern decides physical loop mechanics, it belongs to the substrate
- if a concern decides whether an effect may commit, it belongs to the kernel
- the runtime contract stays narrow even when the substrate grows more capable

## Related Docs

- `docs/architecture/system-architecture.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime.md`
- `docs/reference/proposal-boundary.md`
