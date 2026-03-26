# Research: Subagent Delegation and Isolated Execution

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-03-26`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`
  - `docs/reference/skills.md`
  - `docs/journeys/background-and-parallelism.md`

## Direct Conclusion

This RFC is now best read as a design record plus regression checklist. Stable
contracts and workflows have been promoted into architecture, reference, and
journey docs.

Historical note:

This document describes Brewva's first delegation phase, when the execution
abstraction was centered on `subagent profile`.
The current implementation has moved on to `ExecutionEnvelope`, `AgentSpec`,
and `HostedDelegationTarget`.
References to `profile` in this RFC are historical and should not be read as
the current public delegation contract.

Brewva should adopt subagents, but not as a new kernel-owned authority object
and not as a replacement for skills.

The correct architectural placement is:

- `skill`
  - semantic task contract
  - outputs, effect limits, completion expectations, and budget ceilings
- `subagent profile`
  - isolated execution profile
  - model, tool surface, posture narrowing, and result mode
- `delegation run`
  - one temporary child execution for a bounded slice of work
- `cascade`
  - sequencing across skills
- `worker/session runtime`
  - the execution substrate used to host child runs

In other words:

`skills define what work means; subagents define how isolated work is executed.`

Subagent orchestration should live in the deliberation and gateway control
plane. The kernel should continue to govern effects, receipts, replay, and
durable result admission, but it should not own subagent planning or routing.

## Problem Statement And Scope

Brewva already has strong primitives for:

- skill routing and lifecycle
- explicit cascade progression
- worker-backed session execution
- parallel slot budgets
- patch merge and conflict detection
- effect-governed tool authorization
- replay-first durability

What Brewva does not yet have is a first-class delegation model for:

- isolating noisy exploration from the parent context window
- running bounded child executions in parallel
- using different models or tool surfaces for different slices of work
- returning compressed outcomes instead of raw child transcripts
- preserving auditability without promoting subagent control flow into kernel
  authority

This RFC defines that missing delegation layer.

Explicitly in scope:

- conceptual model and architectural placement
- profile model for subagents
- delegation packet and outcome contracts
- interaction with skills, cascade, worker sessions, and patch merge
- event and durability requirements
- phased rollout

Explicitly out of scope:

- a kernel-owned `runtime.subagents.*` public domain in the first phase
- autonomous nested subagent trees
- direct child-run commitment posture in the initial rollout
- turning channel A2A agents into the generic subagent abstraction
- a second skill system parallel to `runtime.skills.*`

## Why This Fits Brewva

Brewva's constitutional reading remains:

`Intelligence explores. Kernel authorizes effects. Tape remembers commitments.`

This RFC uses that line as the implementation-grade constitutional reading, as
described in `docs/architecture/system-architecture.md`.

Subagents fit naturally inside that line when they are treated as bounded
exploration executors:

- they help exploration stay isolated from the parent context
- they can produce summaries, evidence, and patch candidates
- they can run with narrower permissions than the parent
- they do not need independent kernel authority to be useful

That means the system should not describe subagents as hidden autonomous
co-authors. It should describe them as:

`delegation workers with isolated context, bounded budgets, mergeable outputs, and auditable lifecycles`

## Current Pressure Points

The existing codebase already contains most of the execution substrate, but the
conceptual layer is incomplete.

Important anchors:

- `packages/brewva-runtime/src/services/parallel.ts`
  - per-session parallel slot accounting and worker result recording
- `packages/brewva-runtime/src/parallel/results.ts`
  - patch merge and conflict detection
- `packages/brewva-runtime/src/services/tool-gate.ts`
  - effect posture and runtime authorization
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
  - authoritative skill activation/completion
- `packages/brewva-runtime/src/runtime.ts`
  - domain-level runtime surface exposed to delegated execution
- `packages/brewva-gateway/src/session/worker-main.ts`
  - worker-backed isolated session execution
- `packages/brewva-gateway/src/session/worker-protocol.ts`
  - worker bridge protocol
- `packages/brewva-gateway/src/channels/coordinator.ts`
  - fan-out, discussion, and A2A coordination primitives
- `packages/brewva-gateway/src/channels/agent-runtime-manager.ts`
  - runtime namespacing for multiple agent identities
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
  - skill activation and completion primitives delegated runs must respect

Today these parts exist, but there is no single delegation contract tying them
together. Without that contract, any subagent feature risks collapsing into one
of two bad outcomes:

1. a thin shell wrapper that spawns workers but has no durable semantics
2. an overreaching kernel feature that turns delegation topology into
   authoritative runtime state

## Design Goals

1. Keep parent context windows clean by moving noisy work into isolated child
   runs.
2. Reuse the existing worker/session substrate instead of inventing a second
   runtime executor.
3. Preserve the current skill model as the semantic contract system.
4. Let child runs use narrower model/tool/posture profiles than the parent.
5. Return structured, compressed outcomes instead of raw transcripts by
   default.
6. Keep authoritative skill lifecycle with the parent session in the initial
   design.
7. Preserve replay, auditability, and failure recovery at the child-run
   lifecycle level.
8. Prevent uncontrolled nesting, runaway fan-out, and silent budget expansion.

## Non-Goals

1. Do not make subagents a new public semantic routing namespace parallel to
   skills.
2. Do not let the kernel choose subagent topology adaptively in its admission
   path.
3. Do not let child runs silently mutate parent task, truth, or commitment
   state.
4. Do not introduce commitment-posture child runs in the first product phase.
5. Do not unify temporary subagents with long-lived channel A2A agents.

## Terms And Object Model

### Skill

The semantic task contract. A skill answers:

- what kind of work this is
- what outputs are expected
- what effects are permitted
- what the default resource ceiling and completion definition are

Skills remain the only first-class semantic capability catalog.

### Subagent Profile

The isolated execution profile. A profile answers:

- what kind of worker this is
- what model and reasoning posture it prefers
- what tools it may use
- whether it may only observe or may perform isolated reversible mutation
- what result shape it should return

Profiles are not semantic skills. They are execution personas and isolation
rules.

### Delegation Packet

The bounded parent-to-child handoff object.

It contains the minimum information required for the child run to do useful
work without inheriting the full parent conversation.

### Delegation Run

A single temporary child execution under one profile and one packet.

### Delegation Outcome

The child-to-parent return object.

This is the authoritative output surface of a child run. It is not the raw
child transcript.

### Worker Session

The concrete isolated runtime/session instance that executes a delegation run.

### A2A Agent

A long-lived addressable agent identity used in channel orchestration. This is
not the same as a temporary subagent.

## Decision: Subagents Are A Control-Plane Execution Primitive

The recommended architecture is:

- deliberation/control plane
  - decide whether to delegate
  - select profile
  - construct delegation packet
  - orchestrate fan-out and collection
- gateway/session layer
  - execute child runs on the existing worker substrate
  - stream progress
  - enforce lifecycle, timeout, cancellation, and recovery
- runtime/kernel
  - continue to authorize effects
  - continue to own evidence, receipts, rollback, replay, and verification
  - record child-run lifecycle events and accepted outcome references

The kernel should observe and govern child-run effects and durable results, but
it should not be the owner of delegation planning.

## Options Considered

### Option A: Kernel-Native `runtime.subagents.*`

Approach:

- add a new runtime domain for register/spawn/resume/collect/list/cancel
- make subagents a kernel-owned object model

Pros:

- obvious API surface
- easy to explain as a runtime feature

Cons:

- moves control-plane topology into kernel authority
- expands replay and hydration scope too early
- weakens the current constitutional split between deliberation and commitment

Decision:

- rejected for the first architecture pass

### Option B: Thin Tool Wrapper Around Worker Spawn

Approach:

- add a `subagent_run` tool that spawns isolated workers
- treat the feature as a convenience layer only

Pros:

- fast MVP path
- maximum reuse of existing gateway worker code

Cons:

- too weak as a durable architectural model
- tends to return raw text rather than structured outcomes
- risks becoming a shell feature without replay/audit semantics

Decision:

- acceptable as an implementation entry point
- insufficient as the full architecture

### Option C: Control-Plane Delegation System Over Existing Worker Substrate

Approach:

- define subagent profiles, delegation packets, and structured outcomes
- host orchestration in deliberation/gateway control plane
- reuse worker sessions and runtime governance

Pros:

- aligned with existing rings and lanes
- preserves skill semantics
- reuses worker/session substrate
- supports structured outcome handling, patch merge, and future planner growth

Cons:

- requires explicit contract design before shipping the feature
- requires lifecycle and recovery semantics beyond a basic tool wrapper

Decision:

- recommended

## Proposed Model

### Subagent Profile Contract

Profiles should be static resources, not ad hoc runtime registrations.

Initial shape:

```ts
export interface SubagentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  tools?: string[];
  disallowedTools?: string[];
  posture?: "observe" | "reversible_mutate";
  preferredSkills?: string[];
  allowedSkills?: string[];
  resultMode: "exploration" | "review" | "verification" | "patch";
  maxParallel?: number;
  timeoutMs?: number;
  defaultContextBudget?: {
    maxInjectionTokens?: number;
    maxTurnTokens?: number;
  };
}
```

Important rules:

- profile posture may only narrow parent authority
- profile `posture` is a default, not the final authority for one specific run
- omitted model/tools inherit from the parent execution environment, subject to
  narrowing
- profiles are execution presets, not routable skills
- profiles do not own authoritative completion semantics

Suggested initial built-ins:

- `researcher`
  - read-heavy exploration
- `coder`
  - isolated reversible mutation worker
- `verifier`
  - verification and evidence gathering
- `reviewer`
  - read-heavy correctness and regression review
- `patch-worker`
  - narrowly scoped patch producer

### Delegation Packet

The packet is the most important object in the system because it prevents
context pollution from simply being copied into a new window.

```ts
export interface DelegationPacket {
  objective: string;
  parentSessionId: string;
  parentTurn?: number;
  activeSkillName?: string | null;
  constraints: string[];
  requiredOutputs: string[];
  contextRefs: Array<{
    kind: "event" | "ledger" | "task" | "truth" | "artifact" | "projection" | "workspace_span";
    locator: string;
    summary?: string;
  }>;
  executionHints?: {
    preferredTools?: string[];
    fallbackTools?: string[];
    preferredSkills?: string[];
  };
  contextBudget?: {
    maxInjectionTokens?: number;
    maxTurnTokens?: number;
  };
  effectCeiling: {
    posture: "observe" | "reversible_mutate";
    allowedEffects: string[];
  };
}
```

Rules:

- packets are distilled by default
- packets should reference artifacts and spans instead of embedding broad raw
  history
- the child run should not receive the full parent transcript unless explicitly
  allowed for debugging
- packet construction belongs in the control plane, not in the kernel
- packet-level context budget may tighten any profile default for a specific
  run
- packet `effectCeiling` is the final authority for one run; profile posture is
  only a default and may be narrowed but not widened by the packet
- the initial packet posture is intentionally narrower than the runtime's full
  `ToolInvocationPosture` union because commitment child runs are out of scope
  for the initial rollout; future versions may widen the packet schema to
  include `commitment` without changing the rest of the delegation model

### Delegation Outcome

Child runs return structured outcomes. Raw transcripts are implementation
artifacts, not the public result contract.

```ts
export type DelegationOutcome =
  | ExplorationOutcome
  | PatchOutcome
  | VerificationOutcome
  | ReviewOutcome;

export interface DelegationOutcomeBase {
  runId: string;
  profile: string;
  workerSessionId: string;
  status: "ok" | "error" | "cancelled" | "timeout";
  summary: string;
  evidenceRefs: Array<{
    id: string;
    sourceType: string;
    locator: string;
  }>;
  artifactRefs?: Array<{
    kind: string;
    path: string;
    summary?: string;
  }>;
  metrics?: {
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
  };
  errorMessage?: string;
}

export interface ExplorationOutcome extends DelegationOutcomeBase {
  kind: "exploration";
  findings?: string[];
  candidateOutputs?: Record<string, unknown>;
}

export interface ReviewOutcome extends DelegationOutcomeBase {
  kind: "review";
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    summary: string;
    file?: string;
    symbol?: string;
  }>;
}

export interface VerificationOutcome extends DelegationOutcomeBase {
  kind: "verification";
  blockers?: string[];
  verifierEvidenceKinds?: string[];
}

export interface PatchOutcome extends DelegationOutcomeBase {
  kind: "patch";
  workerResult: WorkerResult;
}
```

Rules:

- every outcome must contain a summary
- patch-producing child runs return `WorkerResult`
- the parent decides whether to merge, promote, reject, or translate outcomes
  into proposals or evidence

## Relationship To Skills

The most important rule is:

`skills remain contracts; subagents remain executors`

Practical implications:

- the parent session continues to own the authoritative active skill
- child runs may preload or prefer skills locally for behavior shaping
- child runs do not complete the parent skill in the initial design
- child runs may return candidate outputs that the parent later adopts,
  validates, and completes under the parent skill lifecycle

This avoids the most dangerous failure mode:

- parent and child sessions independently claiming skill completion

That split would make replay, verification, and output ownership ambiguous.

## Relationship To Cascade

Cascade answers sequencing across skills. Subagents answer isolation and
parallelism within one step or slice of work.

Examples:

- `design -> implementation -> review` remains a cascade concern
- “fan out three read-only repository scans before continuing implementation”
  is a delegation concern
- “run two isolated patch workers for different files, then merge candidates”
  is a delegation concern

Subagents therefore complement cascade. They do not replace it.

## Relationship To A2A Agents

Channel A2A agents are long-lived, addressable, cross-turn identities.

Subagents are:

- temporary
- parent-owned
- task-scoped
- short-lived

The system should not conflate these two concepts even if some worker/session
primitives are reused.

## Runtime And Control-Plane Responsibilities

### Deliberation / Control Plane

Owns:

- deciding whether delegation is warranted
- selecting profiles
- constructing delegation packets
- choosing single vs fan-out vs parent-controlled chain
- collecting outcomes and deciding what to do next

### Gateway / Session Layer

Owns:

- spawning child worker sessions
- applying profile config overlays
- progress streaming
- cancellation and timeout
- crash handling and reconnection logic
- local outcome collection

### Runtime / Kernel

Owns:

- effect authorization inside child runs
- budget enforcement and narrowing
- evidence and ledger recording
- rollback and verification semantics
- durable lifecycle events and replayable references to outcomes

Parent-session cost attribution also belongs here:

- child runs may record local usage under their own worker session
- parent-facing accounting aggregates child usage into the parent session's
  `runtime.cost.getSummary(...)` view
- parent-facing enforcement uses the parent skill/session budget unless a
  resource lease explicitly expands it

The runtime should not own automatic delegation planning.

## Governance And Budget Rules

Subagents should obey these rules:

1. Child authority can only narrow from the parent.
2. Child posture is `<=` parent posture.
3. Child allowed effects are a subset of parent allowed effects.
4. Child tool surface is inherited-then-restricted, not inherited-then-expanded.
5. Child runs consume the parent skill's parallel budget headroom.
6. Additional resource leases remain parent-scoped decisions.
7. Child token and cost consumption is aggregated into the parent session cost
   summary.
8. Child runs share the parent skill's remaining resource budget unless a
   `resource_lease` explicitly expands it.
9. Nested child spawning is disabled in the initial architecture.

Implications:

- `observe` child runs are safe defaults
- `reversible_mutate` child runs require explicit isolation
- `commitment` child runs are out of scope initially

## Isolation Model

### Observe Child Runs

- workspace access may be shared if read-only
- no write-capable tools
- outcome is usually summary, findings, or verification evidence

### Reversible-Mutate Child Runs

- must execute against isolated writable state
- should not patch the parent workspace in place
- should produce patch candidates or worker results for explicit merge

The long-term preferred isolation model is a dedicated child workspace, such as
a temporary worktree or equivalent overlay state root.

Using shared mutable parent state for parallel patch workers is specifically
discouraged because conflict detection is a recovery aid, not the primary
isolation model.

For the first write-capable implementation phase, the default should prefer
snapshot-backed patch capture aligned with existing `PatchSet`,
`WorkerResult`, and merge primitives. Dedicated worktrees remain a stronger
future option once the repository has explicit worktree lifecycle management.

## Lifecycle And Events

The child-run lifecycle should be durable enough for audit and recovery without
turning child transcripts into first-class kernel memory.

Recommended lifecycle events:

- `subagent_run_started`
- `subagent_run_progress`
- `subagent_run_completed`
- `subagent_run_failed`
- `subagent_run_cancelled`
- `subagent_run_merged`

Minimum payload fields should include:

- `runId`
- `profile`
- `parentSessionId`
- `workerSessionId`
- `parentSkill`
- `resultKind`
- `status`
- `artifactRefs` or patch/evidence references when applicable

Guidance:

- progress events should remain compact and operational
- completed/failed events should carry the durable summary and references
- raw child transcripts should remain optional artifacts rather than default
  tape payloads

For parent-context interaction, the initial return path should be:

- inline turn-local outcome summaries may be appended through
  `runtime.context.appendSupplementalInjection(...)`
- outcomes that must survive compaction, arrive after compaction, or need
  replayable re-entry should cross back as `context_packet` proposals rather
  than relying on transient supplemental injection alone

## Replay And Recovery Semantics

This architecture is not complete unless child runs recover coherently.

Required properties:

1. A child run has a durable `runId`.
2. Parent sessions can reconstruct whether a run is:
   - pending
   - running
   - completed
   - failed
   - cancelled
   - merged
3. Child-run outcomes can be reattached to the parent even after process
   restart.
4. Patch-producing outcomes retain a durable artifact or patch identity.
5. Parent skill completion remains replayable without needing the raw child
   transcript.
6. Active delegation runs survive parent-session compaction as lightweight
   session state.
7. Outcomes that arrive after compaction can still re-enter the parent through
   a durable handoff path.

Recommended implementation direction:

- lifecycle state reconstructed from compact events plus child outcome
  artifacts
- supervisor-level worker recovery remains operational, not authoritative
- tape stores lifecycle decisions and durable references, not every streamed
  chunk
- active delegations persisted as lightweight session state containing at least
  `runId`, `profile`, `status`, and parent linkage
- compaction instructions include a `pending_delegations` section for active
  runs
- outcomes that arrive after compaction are delivered as `context_packet`
  proposals or an equivalent replayable outcome handoff, not as assumptions
  about still-live inline tool state

## Proposal Boundary Interaction

Delegation itself should not become a new proposal kind in the first
architecture pass.

Reasoning:

- spawning a read-heavy child run does not by itself cross an authority
  boundary comparable to `skill_selection`, `context_packet`, or
  `effect_commitment`
- treating every delegation as a receipt-bearing proposal would overload the
  boundary with control-flow noise

What may cross the proposal boundary later:

- a child outcome promoted into `context_packet`
- a parent-accepted commitment request generated after child analysis
- other already-defined proposal kinds triggered by parent interpretation of
  child output

For `reversible_mutate` child runs, the child session's own writes still pass
through normal kernel-governed effect authorization via the existing tool gate
path. The parent session does not need to pre-authorize child spawn as a
proposal, but child effects remain runtime-governed inside the child session.

## Tool Surface And Product Entry Point

The initial product entry point should be explicit.

Recommended MVP tool surface:

- `subagent_run`
- `subagent_fanout`

Optional later controls:

- `subagent_status`
- `subagent_cancel`
- `worker_results_merge`
- `worker_results_apply`

Patch-producing child runs can use the existing worker-result merge/adopt
surface instead of introducing a second, subagent-specific merge verb.

The first version should be explicit rather than automatic:

- the parent model or operator asks for a delegated run
- the system executes under a known profile
- the parent receives a structured outcome

Automatic delegation planning can be added later as a deliberation helper after
the contracts and lifecycle semantics are stable.

## Package And File Placement

Recommended direction:

- `packages/brewva-gateway/src/subagents`
  - profile selection and packet construction helpers
  - child-run orchestrator and worker/session integration
- `packages/brewva-gateway`
  - gateway-facing hosting and session lifecycle wiring
- `packages/brewva-tools`
  - explicit managed tools such as `subagent_run`
- `packages/brewva-runtime`
  - event types, outcome/evidence recording helpers, and governance integration

Recommended resource location for static profiles:

- `.brewva/subagents/` or another clearly task-scoped delegation directory

Not recommended:

- reusing `.brewva/agents/` because it already implies long-lived channel agent
  identity

## Phased Rollout

### Phase 0: Contracts

- define `SubagentProfile`, `DelegationPacket`, and `DelegationOutcome`
- define child-run lifecycle event schema
- define the authority-narrowing rules

Exit criteria:

- types and docs are stable enough to implement against

### Phase 1: Explicit Read-Only Delegation

- add `subagent_run`
- reuse worker/session substrate
- support single and fan-out execution
- default to `observe`
- return summary/evidence/artifact references

Exit criteria:

- isolated read-only runs work
- progress, timeout, and cancellation semantics are stable

### Phase 2: Structured Patch Workers

- add isolated `reversible_mutate` child runs
- return `WorkerResult`
- connect to parallel slot accounting and merge primitives
- record merge-related events

Exit criteria:

- parent-controlled merge path works
- conflict reporting is deterministic

### Phase 3: Delegation Planner

- add deliberation-side helpers for profile choice and packet construction
- optionally recommend delegation for exploration-heavy or verifier-heavy work

Exit criteria:

- planner improves outcomes without hiding control flow or widening authority

### Phase 4: Advanced Productization

- richer profile registry and project overlays
- parent-controlled chains of child runs
- improved status inspection and operator UX

## Validation Signals

The design is only valid if the following can be demonstrated:

### Tests

- child authority never exceeds parent authority
- observe child runs cannot mutate
- reversible child runs cannot directly claim parent skill completion
- parallel child runs consume and release parallel slots correctly
- child token and cost usage aggregates into the parent session summary
- patch merge reports remain deterministic
- cancellation and timeout produce stable lifecycle state
- restart recovery reconstructs child-run state without transcript dependence
- compaction and post-compaction outcome delivery remain replayable

### Operational Checks

- parent context growth is materially lower when noisy work is delegated
- child-run summaries remain sufficient for parent continuation
- event tape remains compact enough to replay efficiently
- patch conflicts remain auditable by worker and patch identifiers

### Regression Guards

- no new kernel-owned adaptive planner path
- no duplicate skill lifecycle ownership between parent and child
- no direct commitment posture for child runs in the initial rollout

## Promotion Criteria

This note is ready for promotion when all of the following are true:

1. explicit child-run tooling exists and is stable
2. profile, packet, and outcome contracts are implemented
3. lifecycle events and restart semantics are covered by contract tests
4. write-capable child runs, if enabled, use explicit isolation and explicit
   merge semantics
5. stable docs can describe the feature without hand-waving over ownership,
   authority, or recovery

## Open Questions

1. Should isolated write-capable child runs prefer temporary worktrees, overlay
   workspaces, or snapshot-backed patch capture as the default implementation?
   The current repository already has `FileChangeTracker`, `PatchSet`, and
   `PatchFileChange` primitives, so the default path should continue to align
   with those existing mechanisms even if a later worktree mode is introduced.
2. Should child-run raw transcripts ever be retained by default, or only when a
   debugging profile explicitly requests them?
3. Should project overlays be allowed to tighten subagent profiles in the same
   way they currently tighten skill contracts?
4. At what point, if any, should delegation planning become automatic rather
   than explicit? If automatic delegation is introduced, should that decision
   remain a pure deliberation/control-plane action, or should some delegated
   outcomes cross the proposal boundary in a way comparable to
   `skill_selection`?

## Source Anchors

- `docs/architecture/system-architecture.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/proposal-boundary.md`
- `docs/reference/skills.md`
- `docs/reference/runtime.md`
- `docs/journeys/background-and-parallelism.md`
- `packages/brewva-runtime/src/services/parallel.ts`
- `packages/brewva-runtime/src/parallel/results.ts`
- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `packages/brewva-gateway/src/session/worker-protocol.ts`
- `packages/brewva-gateway/src/channels/coordinator.ts`
- `packages/brewva-gateway/src/channels/agent-runtime-manager.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts`
