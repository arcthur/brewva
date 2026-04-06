# Exploration And Effect Governance

This document fixes Brewva's governing philosophy and architecture for
contract, tool-governance, deliberation, and control-plane design.

It does not replace the constitution. It refines that constitution at the
implementation granularity now used across the runtime.

Interpretation rule:

- this document explains governance style and boundary intent
- it does not authorize planner-shaped logic inside the default hosted path
- if a passage here reads broader than the constitutional or invariant docs,
  the narrower authority contract wins

## Constitutional Reading

The current constitution still stands:

`Intelligence proposes. Kernel commits. Tape remembers.`

The implementation-grade constitutional reading is:

`Intelligence explores. Kernel authorizes effects. Tape remembers commitments.`

These two lines describe the same boundary from two angles:

- `proposes / explores` means the model and the control plane discover paths
  rather than hold authority directly
- `commits / authorizes effects` means the kernel governs commits and world
  changes rather than the reasoning path itself
- `Tape remembers / remembers commitments` means the system remembers committed
  facts rather than every intermediate thought

Implementation notes:

- the runtime now uses explicit `effects`, `resources`, and lease negotiation
  as the primary governance path
- the visible tool surface and execution hints still help the model search, but
  they do not define the authority boundary on their own
- a small set of runtime-owned control-plane tools remains explicitly exempted
  for recovery and negotiation; those exceptions must stay narrow and auditable

## Core Principle

The governance principle is:

`Govern what may happen to the world, not how the model searches for a path.`

In other words:

- the kernel constrains effect boundaries, commit boundaries, verification
  boundaries, and replay boundaries
- deliberation folds reusable artifacts, retrieval signals, continuity state,
  and any optional search assistance outside kernel authority
- the control plane handles dynamic negotiation across cost, risk, and latency

The following two problem classes should no longer be collapsed into one hard
contract:

- `Intent / Effect`
  - what the task should produce
  - what impact on the world is allowed or forbidden
- `Path / Resource Guess`
  - which tools to try first
  - how many tokens or steps the run may roughly consume

The former is governance. The latter is planner work.

Documentation consequence:

- text about negotiation, hints, lanes, or planner work should not be read as a
  license to reintroduce hidden default-path orchestration

## Non-Goals

This document must not be used to justify the following in the default hosted
path:

- default injected workflow prescriptions or lane briefs
- hidden phase/state-machine recovery controllers
- model-writable durable control hints
- telemetry or advisory facts silently becoming kernel-owned optimizer state
- planner behavior being smuggled back in as "presentation" or "guidance"

There is also a separate repository-level question:

`Should this change be reviewed, merged, released, or escalated?`

That question belongs to an adjacent repository-fitness plane rather than to
the runtime commitment lane itself.

## Two Lanes

The system recognizes two distinct lanes.

### `exploration lane`

Used for:

- path search
- hypothesis generation and self-correction
- draft planning, shadow execution, and low-risk probing
- dynamic negotiation of tools and resources

Properties:

- non-authoritative
- discardable
- freer to rearrange context and explore alternate paths
- allowed to use heuristics, retrieval ranking, judging, memory rehydration,
  and temporary packets

### `commitment lane`

Used for:

- real tool execution
- observable side effects
- artifact submission
- verification, receipts, ledger writes, and tape durability

Properties:

- authoritative
- auditable
- replayable
- able to answer why a given change was authorized

The lanes must connect only through explicit boundary crossings such as
proposals, leases, receipts, and effect authorization. Hidden runtime fallback
must not blur the line.

Interpretation reminder:

- lanes are explanatory boundary language
- they do not require a lane controller, phase tracker, or turn-time lane
  injection mechanism

## Contract Split

Contracts are split into four logical layers. These layers are sub-fields
within a single `SkillContract` interface (`intent`, `effects`, `resources`,
`executionHints`), not standalone types.

### `IntentContract`

Describes the definition of completion for a task:

- target artifacts
- output format and quality bars
- completion conditions
- required verification evidence

### `EffectContract`

Describes what side effects are allowed:

- allowed effect classes
- forbidden world-state changes
- effect-denial boundaries that cannot be relaxed by overlays or config

### `ResourcePolicy`

Describes resource boundaries, but should distinguish between:

- kernel hard ceilings
- control-plane soft defaults
- temporary leases that deliberation may request

Resource policy should not default to a skill author's prewritten execution
path.

### `ExecutionHints`

Describes empirical guidance rather than authority:

- preferred tools
- suggested chains
- historical priors
- cost estimates
- convergence guidance

This information should serve planners, recovery controllers, and future
orchestrators rather than directly becoming kernel commit conditions.

## Governance Style

The governance style moves from "predefined path" to
"authorize effects plus negotiate resources."

That implies:

- `denied` is closer to true governance semantics than `required`
- `tool name` is an effect carrier, not an authority primitive
- `required tools` are planner hints, not authority fields
- `per-skill maxToolCalls / maxTokens` are default leases, while real hard
  ceilings come from session or global policy
- when resources are insufficient, the system should prefer lease negotiation
  over flattening every exploratory impulse into a hard failure

Governance becomes more like a dialogue:

- intelligence explains why additional budget is needed, or why a different
  commitment boundary should be proposed
- the control plane evaluates risk and value
- the kernel authorizes or rejects only at the effect and commit boundary

Current implementation note:

- `resource_lease` is budget-only and active-skill-scoped
- it may expand resource ceilings with a receipt
- it does not widen effect authorization

## Tool And Governance Model

Authority should not be based primarily on static tool allowlists. It should be
based on effect classes and explicit governance boundaries such as resource
ceilings.

## Hosted Recovery And Scheduler Traits

Hosted recovery is now explicit and bounded rather than implicit and
planner-shaped.

Stable rules:

- hosted continuation and retry posture must surface through
  `session_turn_transition`
- provider recovery remains bounded and descriptive; it must not silently widen
  authority or hide operator-visible governance facts
- scheduler-facing execution traits such as concurrency safety or interrupt
  behavior are distinct from `ToolGovernanceDescriptor`
- a tool may be safe from an authority perspective and still require exclusive
  scheduling for a given invocation

The design intent is narrow:

- governance decides what the system may do to the world
- hosted recovery decides how the user-facing turn may continue after bounded
  failure or context pressure
- scheduler traits decide how hosted execution overlaps or interrupts work

## Reasoning Branch Revert

Reasoning-path rollback is now explicit, but it still does not widen kernel
authority over raw thought.

Stable rules:

- the runtime may admit durable `reasoning_checkpoint` and `reasoning_revert`
  receipts as branch-continuity commitments
- these receipts govern which reasoning lineage remains model-visible after a
  reset, but they do not authorize effects on their own
- reasoning revert does not imply filesystem rollback, approval reset, cost
  reset, or evidence erasure
- `reasoning_revert_resume` is a hosted recovery surface that explains the next
  continuation attempt after branch reset; it does not replace tape truth

Interpretation rule:

- the model may explore freely until a reasoning receipt is durably admitted
- once admitted, branch continuity becomes replay-visible and operator-auditable
- this keeps "govern effects, not search" intact while still giving the system
  a first-class way to discard a bad reasoning branch

## Deployment Boundary Ownership

Deployment boundary policy is now a stable part of the governance model.

The architectural split is:

- tool governance descriptors classify what kind of effect a tool carries
- deployment boundary policy constrains where that effect may land in a
  specific deployment
- execution adapters enforce the resulting decision at the concrete tool
  boundary

That means hostnames, filesystem roots, and similar deployment-specific rules
do not belong inside `ToolGovernanceDescriptor`.
They belong in runtime config and are evaluated on the shared invocation path
for the small set of tools that need argument-aware classification.

Current implementation notes:

- `runtime.authority.tools.start(...)` remains the single shared authorization entrypoint
- `ToolGateService` applies boundary-policy checks only for classified
  high-risk tools such as `exec` and browser entrypoints
- `runtime.inspect.tools.explainAccess(...)` can explain boundary-policy decisions
  without executing the tool

## Secret And Guard Ownership

Two adjacent controls now follow the same architectural rule: kernel-owned
authority, model-invisible payloads.

- durable secrets live in the credential vault and are referenced by opaque
  refs rather than inline config or model-visible arguments
- gateway token storage and tool credential bindings resolve those refs only at
  the execution boundary
- exact-call loop protection stays inside the existing tool gate rather than
  creating a second guard framework or public security domain

The result stays aligned with the core principle of this document:

- effect descriptors classify authority
- deployment policy narrows reachable world surface
- vault and guard state stay runtime-owned and auditable

Examples of higher-value governance targets include:

- whether workspace reads are allowed
- whether workspace writes are allowed
- whether local command execution is allowed
- whether network access is allowed
- whether external system interaction is allowed
- whether secret or high-value data access is allowed
- whether future scheduling intents may be created

The tool layer still matters, but it should answer how an effect is carried,
not single-handedly define what world changes are allowed.

Current implementation note:

- managed Brewva tools now expose effect governance metadata on the tool
  definition object itself as a canonical view over exact managed-tool policy
- the default gateway/runtime path imports that descriptor metadata before
  relying on registry lookup
- managed tool disclosure may use execution hints for prioritization
- the visible skill-oriented surface still includes managed tools whose known
  effect descriptors are authorized by the current effect contract

## Verification Consequences

Verification should align with the same principle:

- prioritize artifact quality, effect legality, post-write evidence, and
  rollback viability
- avoid turning verification into a rigid process template
- allow different paths to converge on the same completion definition

This does not weaken verification. It makes verification target the thing that
actually needs to be trusted.

Current boundary clarification:

- runtime verification asks whether the current session or task has the
  evidence needed for trustworthy completion and post-write confidence
- repository fitness asks whether a repository change has passed the right
  change-level gates, routing rules, and release checks

The two may exchange evidence, but they should not be collapsed into one
undifferentiated `verification` layer.

## Non-goals

This architecture does not mean:

- turning the kernel into an adaptive planner
- removing all budget and resource ceilings
- replacing pre-authorization with post-hoc audit
- deleting current tool gating in one step
- allowing the model to expand authority without receipts
- turning the runtime kernel into a repository-local merge or release gate
- treating workflow posture or runtime verification freshness as sufficient
  repository fitness on their own

## Related Documents

- `docs/architecture/system-architecture.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/proposal-boundary.md`
- `docs/research/archive/rfc-effect-governance-and-contract-vnext.md`
