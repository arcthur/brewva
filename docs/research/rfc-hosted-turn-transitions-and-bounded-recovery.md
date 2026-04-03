# Research: Hosted Turn Transitions and Bounded Recovery

## Document Metadata

- Status: `promoted`
- Owner: gateway and runtime maintainers
- Last reviewed: `2026-04-03`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Direct Conclusion

Brewva should introduce an explicit hosted-turn execution model with:

1. first-class `TurnTransitionReason` semantics for every turn continuation
2. a bounded `RecoveryPolicy` chain for provider failure, context pressure, and
   interruption handling
3. a clear separation between experience-ring recovery and kernel authority

This proposal is intentionally not backward compatible.

The hosted execution layer should stop preserving older implicit retry and
continuation behavior. The new model should replace it with explicit,
evented, rebuildable transition semantics that are easier to reason about,
test, and operate.

The long-term constitutional split remains unchanged:

`kernel authorizes effects, receipts, rollback, and replay; hosted execution owns turn orchestration, recovery posture, and user-facing flow`

## Problem Statement And Scope

Brewva already has stronger kernel discipline than most agent products:

- effect authority is explicit
- reversible mutation is receipt-bearing
- approval state is replay-first
- WAL-based recovery is already part of the runtime contract

The weaker area is not kernel rigor. It is hosted execution semantics.

Today, turn-driving behavior is spread across several gateway surfaces:

- `packages/brewva-gateway/src/session/collect-output.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `packages/brewva-gateway/src/channels/channel-turn-dispatcher.ts`
- `packages/brewva-gateway/src/session/compaction-recovery.ts`

That split is structurally acceptable, but the continuation semantics are still
too implicit. Recovery reasons are often inferred from event sequences, logs,
or local control flow rather than represented as first-class product state.

The practical result is predictable:

- recovery paths are harder to test than normal paths
- telemetry says what happened in fragments rather than in one transition model
- compaction, retry, and fallback logic can accrete as special cases
- interruption semantics risk becoming transport-shaped instead of product-shaped

The long-term problem is therefore not "how do we add more retry logic?"

It is:

`how do we make hosted execution explicit, bounded, rebuildable, and durable without widening kernel authority?`

In scope:

- hosted turn continuation semantics
- bounded recovery policy ordering
- compaction and provider-failure recovery posture
- interruption reason taxonomy
- tool execution traits used by the hosted scheduler
- hosted lifecycle visibility for delegated work

Out of scope:

- moving recovery authority into the runtime kernel
- replacing receipt-based effect authorization
- making hosted transitions a new source of truth for effect history
- preserving legacy hosted continuation behavior for compatibility

## First Principles

This proposal starts from five first principles.

### 1. Context Is Finite

Agent systems always run inside bounded context windows.
Therefore, context pressure is not an exception path. It is a normal operating
condition.

The system should treat compaction, selective suppression, and budget-aware
continuation as expected control flow, not emergency patches.

### 2. Failure Is Normal

Provider limits, transient transport failures, output truncation, and
interruption are not rare edge cases.
They are normal runtime realities in long-running interactive systems.

The default design posture should therefore be:

`design the failure path first, then make the success path the shortest special case`

### 3. Authority Must Stay Narrow

The component that improves user experience should not silently gain effect
authority.

Hosted execution may retry, compact, defer, reorder, or surface a clearer user
experience, but it must not:

- invent committed effects
- bypass approval
- rewrite replay truth
- redefine rollback semantics

### 4. Recovery Must Be Explicit

Implicit control flow produces opaque systems.

The reason a turn continues should be observable as a named transition, not
only reconstructed from a mixture of logs, prompts, and provider responses.

### 5. Rebuildability Beats Hidden Cleverness

Hosted state does not need to be kernel truth, but it should still be
rebuildable from durable events and stable projections.

This allows the experience ring to be operationally rich without becoming a
second hidden authority plane.

## Decision Options

### Option A: Keep Recovery Implicit And Add More Local Guards

Summary:
Keep the current hosted structure and extend it with additional targeted retry
and compaction patches.

Pros:

- minimal short-term disruption
- lowest immediate implementation cost

Cons:

- recovery semantics remain fragmented
- telemetry remains descriptive rather than constitutional
- long-term maintenance cost keeps rising
- tests still need to infer intent from side effects

Risk:

This option preserves accidental behavior and makes later cleanup harder.

### Option B: Introduce Hosted Turn Transitions But Preserve Legacy Semantics

Summary:
Add explicit transitions while keeping older continuation and retry behavior
alive behind compatibility branches.

Pros:

- lower migration shock
- easier near-term rollout

Cons:

- duplicates semantics in old and new forms
- prolongs implicit behavior
- weakens the clarity of the new model

Risk:

The compatibility layer becomes the real product surface and blocks simplification.

### Option C: Replace Hosted Continuation Semantics With A New Explicit Model

Summary:
Introduce a new hosted-turn state model, bounded recovery chain, and explicit
transition taxonomy without preserving legacy compatibility behavior.

Pros:

- coherent long-term architecture
- simpler testing and telemetry
- clean boundary between hosted recovery and kernel authority
- easier future optimization without semantic drift

Cons:

- higher near-term migration cost
- requires intentional changes to hosted events, projections, and operator expectations

Risk:

The transition must be carefully staged to avoid partial adoption.

Recommended option: `Option C`

The rest of this RFC specifies that replacement model.

## Proposed Architecture

### 1. Hosted Turns Become An Explicit State Machine

The hosted session layer should model each continuation as a transition with an
explicit reason and bounded associated context.

The vocabulary below is illustrative, not exhaustive.
The final taxonomy should cover all existing hosted continuation paths, not
just provider-driven recovery paths inherited from terminal-style agent
products.
That includes Brewva-native waits and resumes such as context compaction gate
blocking, effect-commitment approval waiting, and WAL-originated resume paths.

Illustrative shape:

```ts
export type TurnTransitionReason =
  | "next_turn"
  | "compaction_gate_blocked"
  | "compaction_retry"
  | "effect_commitment_pending"
  | "provider_fallback_retry"
  | "max_output_recovery"
  | "token_budget_continuation"
  | "stop_blocked"
  | "subagent_delivery_pending"
  | "wal_recovery_resume"
  | "user_submit_interrupt"
  | "signal_interrupt"
  | "timeout_interrupt";

export interface TurnTransitionRecord {
  sessionId: string;
  turnId: string;
  reason: TurnTransitionReason;
  sequence: number;
  recoveryAttempt?: number;
  providerModel?: string;
  notes?: string[];
}
```

This is a hosted execution contract, not a kernel authority contract.

The hosted loop may still be implemented across multiple modules, but all
continuation sites must emit one transition record shape.
That gives the system one inspectable grammar for "why the loop continued."

### 2. Recovery Is A Bounded Policy Chain

Recovery should stop being an ad hoc collection of local retries.

Instead, each hosted turn should evaluate an ordered `RecoveryPolicy[]` chain.
The policy chain should move from cheapest and most deterministic strategies to
more expensive and more lossy ones.

Recommended order:

1. deterministic context reduction
2. output budget escalation when the provider supports a larger budget for the
   same semantic request
3. bounded compaction retry
4. provider fallback retry
5. bounded max-output recovery
6. final surfaced failure

This ordering matters.

The system should spend deterministic reductions before summary-based ones, and
it should spend summary-based recovery before abandoning the turn.
It should also attempt cheap parameter-only escalation before it spends lossy
recovery steps such as compaction or model fallback.

Each policy must declare:

- trigger conditions
- maximum attempts per turn
- optional session-level consecutive-failure threshold
- breaker reset conditions
- transition reason emitted on retry
- failure mode when exhausted

No hosted recovery path should be unbounded by default.

Some policy families, especially compaction, require session-scoped circuit
breakers rather than only per-turn attempt caps.
If a session hits repeated consecutive failures for the same recovery family,
later turns should stop attempting that policy until an explicit reset
condition has been satisfied.
Successful execution should reset the consecutive-failure counter.

### 3. Context Pressure Uses A Strategy Ladder

Context pressure should be treated as a first-class operating regime.

The hosted layer should adopt a compaction strategy ladder rather than a single
summary-heavy response.

Recommended progression:

1. remove superseded or duplicate hosted context segments
2. tighten injection admission using deterministic arena rules
3. compact volatile tool-heavy detail
4. summarize only when deterministic reductions are exhausted
5. fail clearly when the bounded ladder is exhausted

This proposal deliberately prefers deterministic suppression before
probabilistic summarization.

That matches Brewva's existing context philosophy:

`resource expansion is negotiated, not assumed`

The current `ContextPressureService`, `HostedCompactionController`, and
`compaction-recovery.ts` surfaces should converge on that ordered model.

### 4. Withheld Error Applies Only Before Authority Boundaries

Hosted execution should use a withheld-error pattern for recoverable provider
failures such as context overflow or transient model unavailability.

That means:

- the system may delay surfacing a provider error while it attempts one bounded
  recovery pass
- if recovery succeeds, the user sees the successful continuation rather than
  a transient failure
- if recovery fails, the final surfaced error must describe both the root cause
  and the exhausted recovery posture

This pattern must stop at authority boundaries.

Hosted execution must not withhold:

- effect authorization failure
- approval-required state
- rollback failure
- ledger-visible mutation failure

Those are not mere user-experience details. They are constitutional runtime facts.

Implementation rule:

if the current turn has already emitted any operator-visible governance or
runtime-control fact, provider errors must no longer be withheld behind a
silent retry.

Examples include:

- `tool_call_blocked`
- `context_compaction_gate_blocked_tool`
- `effect_commitment_approval_requested`
- rollback-visible failure events

Once such a fact exists, later provider failures may be appended or
co-reported, but they must not be hidden as though the turn had remained purely
recoverable.

### 5. Tool Scheduling Uses Execution Traits, Not Governance Leakage

Brewva should improve hosted tool scheduling, but it should do so without
deriving scheduler behavior from effect authority metadata alone.

The hosted scheduler should use invocation-resolved execution traits rather
than only static per-tool declarations.
The same tool may be concurrency-safe for one input and serial-only for
another, so the scheduling surface should be input-aware.

Illustrative shape:

```ts
export interface ToolExecutionTraits {
  concurrencySafe?: boolean;
  interruptBehavior?: "cancel" | "block";
  streamingEligible?: boolean;
  contextModifying?: boolean;
}

export interface ToolExecutionTraitResolverInput {
  toolName: string;
  args?: Record<string, unknown>;
  cwd?: string;
}

export type ResolveToolExecutionTraits = (
  input: ToolExecutionTraitResolverInput,
) => ToolExecutionTraits;
```

This keeps a clean split:

- `ToolGovernanceDescriptor` describes authority, effect posture, and policy
- `ToolExecutionTraits` describes scheduler behavior in hosted execution

That separation matters because "safe" is not the same thing as
"concurrency-safe," and effect classification is not the same thing as
streaming overlap eligibility.

The invocation spine remains authoritative for lifecycle begin and complete
events. The hosted scheduler merely decides how to order and overlap requests
before or around that authoritative boundary.

### 6. Interruption Must Be Semantically Typed

The system should distinguish interruption reasons that matter operationally.

At minimum, hosted execution should separate:

- user-submitted interruption
- process signal interruption
- watchdog or timeout interruption

These are not equivalent.

They imply different operator expectations, different recovery eligibility, and
different telemetry.

A user-submitted interruption usually means "superseded by a newer intent."
A timeout means "this path failed to make bounded progress."
A signal often means process- or environment-level interruption.

The hosted event surface should reflect those distinctions directly.
The current coarse `session_interrupted` label is not sufficient as the final
inspection grammar.

### 7. Delegation Stays Isolated, But Its Lifecycle Becomes More Observable

Brewva is already ahead of typical agent systems here.

It should keep:

- isolated child workspaces
- typed delegation outcomes
- parent-controlled adoption for effectful child work
- separate runtime verification authority

What should change is lifecycle visibility.

Hosted execution should represent delegation-related continuations explicitly,
for example:

- `subagent_delivery_pending`
- `subagent_retry_pending`
- `subagent_outcome_rejected`

This does not change child authority.
It simply makes delegation status part of the same hosted-turn grammar as other
continuation paths.

### 8. Hosted Transitions Must Be Durable Enough To Rebuild

Transition records should be emitted as durable hosted events and folded into
session projections.

That gives Brewva:

- better operator inspection
- easier debugging
- cleaner test assertions
- easier reconstruction after process restart

But the hosted transition stream should not pretend to be kernel truth.

The correct split is:

- kernel receipts and WAL remain the source of truth for authority and recovery
- hosted transitions remain the source of truth for experience-ring flow

Both are durable. Only one is constitutional.

## No Backward Compatibility

This proposal explicitly rejects a backward-compatibility posture.

The long-term system should not preserve older hosted semantics merely because
they existed first.

The following compatibility strategies are explicitly rejected:

- keeping older implicit continuation behavior alive behind compatibility flags
- dual-writing old and new transition semantics indefinitely
- preserving opaque retry paths whose intent cannot be reconstructed from the
  new transition grammar
- treating legacy event names as permanent aliases
- carrying forward summary-first compaction behavior if it conflicts with the
  new deterministic-first ladder
- preserving process-local `WeakMap` or `Proxy` session-wrapping machinery as a
  long-term compatibility substrate for compaction recovery

Migration should be forward-only.

If the new hosted model is adopted, older hosted recovery semantics should be
removed rather than emulated.

That is the only credible way to obtain a stable long-term control model.

## Architectural Boundaries

Primary implementation surfaces:

- `packages/brewva-gateway/src/session/collect-output.ts`
- `packages/brewva-gateway/src/session/compaction-recovery.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `packages/brewva-gateway/src/channels/channel-turn-dispatcher.ts`
- `packages/brewva-gateway/src/subagents/orchestrator.ts`

Adjacent runtime surfaces that must remain authoritative and narrow:

- `packages/brewva-runtime/src/services/tool-invocation-spine.ts`
- `packages/brewva-runtime/src/services/context-pressure.ts`
- `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
- `packages/brewva-runtime/src/channels/turn-wal-recovery.ts`

The gateway should become richer in explicit recovery semantics.
The runtime should not become more permissive in authority.

## Source Anchors

Code:

- `packages/brewva-gateway/src/session/collect-output.ts`
- `packages/brewva-gateway/src/session/compaction-recovery.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `packages/brewva-gateway/src/channels/channel-turn-dispatcher.ts`
- `packages/brewva-gateway/src/subagents/orchestrator.ts`
- `packages/brewva-runtime/src/services/tool-invocation-spine.ts`
- `packages/brewva-runtime/src/services/context-pressure.ts`
- `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
- `packages/brewva-runtime/src/channels/turn-wal-recovery.ts`

Docs:

- `docs/architecture/system-architecture.md`
- `docs/architecture/exploration-and-effect-governance.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/journeys/internal/context-and-compaction.md`
- `docs/research/rfc-boundary-first-subtraction-and-model-native-recovery.md`
- `docs/research/rfc-durability-taxonomy-and-rebuildable-surface-narrowing.md`
- `docs/research/rfc-gateway-experience-ring-decomposition.md`
- `docs/research/rfc-subagent-delegation-and-isolated-execution.md`

## Validation Signals

The proposal is on track only if the following become true:

1. hosted continuation tests assert transition reasons directly rather than
   inferring them from prompt or log text
2. provider overflow and transient model failures use one bounded recovery path
   instead of scattered local retry behavior
3. compaction order is observable and deterministic-first
4. interruption telemetry separates user, timeout, and signal causes
5. subagent delivery and rejection states are visible in hosted projections
6. runtime authority tests remain unchanged in principle and do not gain hidden
   hosted shortcuts
7. any hosted transition that forces a kernel invariant test to change its
   constitutional expectation is a design violation, not a test gap

Operational signals to watch during implementation:

- recovery-attempt histograms by transition reason
- rate of exhausted recovery chains
- rate of open recovery circuit breakers by policy family
- compaction ladder step distribution
- time spent in `subagent_delivery_pending`
- count of surfaced provider failures after withheld recovery exhaustion

## Risks

### 1. Hosted Execution Becomes A Hidden Planner

If transition logic starts making authority-bearing decisions, the design has
failed.

Mitigation:
keep hosted transitions descriptive and recovery-scoped, not effect-authoritative.

### 2. Transition Taxonomy Grows Without Discipline

If every local branch creates a new public reason, the taxonomy loses value.

Mitigation:
require each transition reason to be operator-meaningful, testable, and stable.

### 3. Compaction Falls Back To Summary Too Early

If the ladder jumps to summary before deterministic reductions are exhausted,
context quality degrades too quickly.

Mitigation:
require deterministic-first ordering and track step usage explicitly.

### 4. Retry Exhaustion Becomes Opaque

If the final surfaced error hides the attempted recovery chain, operators lose
causal visibility.

Mitigation:
surface exhausted recovery posture in the final error contract.

## Implementation Phases

### Phase 1: Turn Transition Taxonomy

- define the hosted `TurnTransitionReason` vocabulary
- include Brewva-native continuation paths such as compaction gating,
  effect-commitment waiting, and WAL resume
- emit durable hosted transition events
- project the latest transition state into session inspection surfaces
- replace process-local `WeakMap` and `Proxy` compaction session wrapping with
  explicit session-scoped transition and controller state keyed by durable
  session identity

### Phase 2: Bounded Recovery Chain

- replace scattered hosted retry branches with a shared `RecoveryPolicy[]`
  pipeline
- implement bounded recovery accounting, session-level circuit breakers, and
  explicit breaker reset semantics

### Phase 3: Deterministic-First Compaction Ladder

- define ordered compaction strategies
- align hosted compaction controller and recovery surfaces to that ordering

### Phase 4: Tool Execution Traits

- add scheduler-facing tool execution traits
- keep governance metadata authority-focused and separate

### Phase 5: Delegation Lifecycle Visibility

- emit hosted delegation transition reasons
- project child lifecycle waiting states into hosted session inspection

## Promotion Criteria

This note should move into stable docs when all of the following are true:

1. hosted turn transitions exist as a stable event and projection surface
2. bounded recovery policy ordering has replaced legacy hosted retry branches
3. compaction behavior follows a deterministic-first ladder
4. tool scheduling uses explicit execution traits rather than governance leakage
5. hosted delegation waiting states are inspectable
6. stable docs fully describe the operator-facing semantics

At promotion time:

- architecture docs should define the boundary between hosted recovery and
  kernel authority
- reference docs should define stable event names and inspection surfaces
- journey docs should explain operational debugging and context-pressure flow
