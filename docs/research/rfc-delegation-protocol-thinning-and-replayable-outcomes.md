# Research: Delegation Protocol Thinning and Replayable Outcomes

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-04-02`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`
  - `docs/journeys/operator/background-and-parallelism.md`

## Direct Conclusion

This RFC is now a historical transition record.

Brewva should keep its constitutional split:

`kernel governs effects, receipts, and replay; deliberation governs delegation and path-finding`

The next delegation step should therefore not make the kernel smarter and it
should not add a hidden planner.

It should do four simpler things instead:

1. thin the primary delegation abstraction from profile-heavy presets toward a
   small execution shape plus optional hints
2. turn delegation packets and outcomes into more typed, composable protocol
   objects rather than mainly prompt text
3. add a replayable parent-facing handoff for background and late child
   outcomes
4. add intent-level completion semantics for long-running delegated work

This RFC recommends that Brewva move in that direction while preserving the
current invariants:

- skills still define what work means
- child authority still only narrows from the parent
- parent-controlled merge remains the only write adoption path
- replayable commitments remain kernel-owned

The execution-shape contract, typed refs and outcomes, replayable late-result
handoff, and completion predicates described here have now been implemented and
promoted into stable architecture, reference, and journey docs.

Historical note:

This file captures an intermediate phase between the original `subagent
profile` model and the final skill-first delegation model.
Some transition details discussed here, including legacy profile-based request
shapes and packet-level `entrySkill`, were not kept in the final public
contract.

Current-state clarification (2026-04-02):

- delegated result kinds are now `exploration`, `plan`, `review`, `qa`, and
  `patch`
- delegated `plan` is a first-class outcome contract for machine-readable
  planning handoffs
- delegated `qa` replaced the older delegated `verification` outcome kind
- `runtime.verification.*` remains separate kernel authority and is not a
  delegated result mode

Read current delegation semantics from stable docs and the promoted
skill-first delegation RFC.

## Problem Statement And Scope

Brewva already has a strong first delegation phase:

- child runs are isolated from the parent context window
- child authority narrows from the parent
- effectful patch work is parent-adopted rather than silently applied
- child lifecycle and recovery are already durable enough to be useful

The next problem is different.
It is no longer "how do we add subagents at all?"
It is now:

`how do we make delegation more model-native and more composable without widening kernel authority?`

In scope:

- thinner execution-shape contracts
- typed delegation references
- typed outcome envelopes
- replayable parent-facing outcome handoff
- intent-level completion predicates for background runs
- shared evidence surfaces for better delegation awareness

Out of scope:

- a kernel-owned delegation planner
- automatic patch adoption
- repository merge or release authority
- direct peer-to-peer messaging as the default temporary-worker model
- autonomous nested delegation trees in this phase

## What

### 1. Thin The Primary Execution Abstraction

Today, built-in delegation profiles still bundle multiple decisions together:

- boundary
- result mode
- tool surface
- model choice
- context budget
- prompt framing

That is acceptable for an initial product phase, but it is not the ideal
long-term abstraction for stronger models.

The primary runtime-facing abstraction is now a thin execution shape:

```ts
export type DelegationBoundary = "safe" | "effectful";
export type SubagentResultMode = "exploration" | "review" | "verification" | "patch";
export type ManagedToolMode = "direct" | "extension";

export interface SubagentExecutionShape {
  resultMode?: SubagentResultMode;
  boundary?: DelegationBoundary;
  model?: string;
  managedToolMode?: ManagedToolMode;
}
```

Profiles should remain available, but only as optional presets or overlays.
They should not remain the dominant semantic object for delegation planning.

Important clarification:

`executionHints`, `contextBudget`, and `entrySkill` remain packet-level fields.
They do not live on `SubagentExecutionShape`, but they are no longer only
prompt-visible hints. They now participate in effective execution assembly.

Important implementation note:

current profiles are not only cosmetic presets. They currently act as runtime
anchors for:

- tool-surface narrowing
- managed tool mode and model selection defaults
- budget defaults
- prompt framing
- project overlay tightening validation

That means profile thinning cannot simply delete profiles and let deliberation
construct arbitrary child environments.

The replacement must include an explicit narrowing validator such as:

```ts
export interface EffectiveDelegationShape {
  boundary: DelegationBoundary;
  resultMode: SubagentResultMode;
  builtinTools: string[];
  managedTools: string[];
  modelHint?: string;
  budgetHints?: {
    maxInjectionTokens?: number;
    maxTurnTokens?: number;
    maxParallel?: number;
  };
}

export function assertDelegationShapeNarrowing(
  parent: EffectiveDelegationShape,
  child: EffectiveDelegationShape,
): void {
  // child authority may only narrow from parent
}
```

In other words:

- profiles may become optional presets
- narrowing must remain mandatory
- the mandatory part should move into an explicit validator, not disappear

### 2. Make Delegation Packet References Typed And Better Addressed

Current delegation packets already avoid copying the full parent transcript,
which is correct. The next step is to make packet references less text-shaped
and more protocol-shaped.

Recommended direction:

```ts
export interface DelegationRef {
  kind: DelegationRefKind;
  locator: string;
  sourceSessionId?: string;
  hash?: string;
  summary?: string;
}
```

The packet should continue to be distilled by default, but the references
inside it should become stronger than plain locator strings rendered back into
prompt bullets.

Implementation notes:

- `sourceSessionId` removes ambiguity from session-scoped evidence
- `hash` is advisory by default, not kernel-verified
- `SubagentContextRef` is now a type alias for `DelegationRef`
- `SubagentOutcomeEvidenceRef` is also a type alias for `DelegationRef`
- a generic `fetchHint` or on-demand ref fetch surface is still deferred

This RFC does not recommend making the kernel responsible for validating
reference content hashes.

### 3. Make Outcomes Typed By Result Mode

The current outcome surface is useful but still too text-first. Stronger models
will benefit from child results that can be consumed as typed work products.

Recommended direction:

```ts
export interface SubagentOutcomeBase {
  runId: string;
  profile: string;
  label?: string;
  workerSessionId?: string;
  kind: SubagentResultMode;
  status: "ok" | "error" | "cancelled" | "timeout";
  summary: string;
  assistantText?: string;
  data?: SubagentOutcomeData;
  artifactRefs?: Array<{
    kind: string;
    path: string;
    summary?: string;
  }>;
  evidenceRefs: DelegationRef[];
  metrics: SubagentOutcomeMetricSummary;
  patches?: PatchSet;
}

export interface ExplorationSubagentOutcomeData {
  kind: "exploration";
  findings?: string[];
  openQuestions?: string[];
  nextSteps?: string[];
}

export interface ReviewSubagentOutcomeData {
  kind: "review";
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    summary: string;
    evidenceRefs?: string[];
  }>;
}

export interface VerificationSubagentOutcomeData {
  kind: "verification";
  verdict?: "pass" | "fail" | "inconclusive";
  checks: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
    summary?: string;
    evidenceRefs?: string[];
  }>;
}

export interface PatchSubagentOutcomeData {
  kind: "patch";
  patchSummary?: string;
  changes?: Array<{
    path: string;
    action?: "add" | "modify" | "delete";
    summary?: string;
    evidenceRefs?: string[];
  }>;
}
```

The key point is not more schema for its own sake. The point is to let child
work become composable without replaying the full transcript.

Important clarification:

`data` is intentionally optional. The current implementation uses structured
extraction when possible and gracefully degrades to text-only outcomes when the
child response omits or fails the structured block.

### 3a. Add An Explicit Outcome Extraction Mechanism

Typed outcomes will not appear automatically if the child execution path still
relies on free-form assistant prose alone.

The system therefore needs an explicit extraction mechanism. Two valid options
exist:

1. model-native structured output
   - child runs emit a strict structured block or JSON envelope
   - gateway validates and lifts that block into a typed outcome
2. tool-native structured reporting
   - child runs call an explicit reporting tool such as `delegation_report`
   - the tool payload becomes the typed outcome source of truth

Current implementation detail:

- the model emits one sentinel-wrapped JSON block
- the delimiters are `<delegation_outcome_json>` and
  `</delegation_outcome_json>`
- `structured-outcome.ts` parses that block defensively and leaves `data`
  unset on parse failure while preserving `summary` and `assistantText`

Preferred direction:

- keep the mechanism explicit
- keep it gateway/control-plane owned rather than kernel-owned
- do not rely on best-effort parsing of arbitrary prose as the long-term path

An initial implementation may use model-native structured output for ergonomics,
but the durable target should remain an explicit structured reporting surface.

### 4. Add Replayable Parent-Facing Outcome Handoff

This remains the main open contract gap in the current delegation path.

Background child outcomes are already durable as lifecycle records and outcome
artifacts, but the parent-facing re-entry path is still weaker than it should
be. Same-turn supplemental injection is useful, but it is not a complete
replayable handoff for late results.

Promoted implementation status:

- `DelegationDeliveryRecord` already tracks `handoffState`, `readyAt`, and
  `surfacedAt`
- background runs can persist `pending_parent_turn` handoff state
- `workflow_status` and `subagent_status` already expose pending outcome state
- parent turns already surface a concise `[CompletedDelegationOutcomes]` block
- surfacing is durable through the `subagent_delivery_surfaced` lifecycle event

Recommended direction:

- keep same-turn `supplemental` delivery for immediate narrative continuity
- add a replayable delegation outcome inbox or outcome-ref handoff for
  background and late results
- make that handoff visible through runtime session state and durable events
- keep parent interpretation explicit; the handoff should not auto-apply
  patches, auto-complete skills, or silently rewrite context

This gives Brewva a durable child-to-parent bridge without widening kernel
authority.

Important implementation note:

the existing delegation hydration fold already provides most of the replay
substrate for child lifecycle state. The main missing piece is the
parent-facing product handoff, not basic durability.

Promoted contract:

- `HostedDelegationStore.listPendingOutcomes(...)` is the stable derived
  handoff view for late detached outcomes
- parent-turn context composition may surface those results through
  `[CompletedDelegationOutcomes]`
- `subagent_delivery_surfaced` records when a pending outcome becomes visible
  to the parent turn

The promoted path uses derived session state rather than introducing a new
kernel proposal kind.

### 5. Add Intent-Level Completion Predicates

Current background delegation primarily manages process lifecycle:

- start
- inspect
- cancel
- timeout

That is necessary, but future delegated work also needs a thin notion of
intent-level convergence.

Recommended direction:

```ts
export type DelegationCompletionPredicate =
  | {
      source: "events";
      type: string;
      match?: Record<string, string | number | boolean | null>;
      policy: "cancel_when_true";
    }
  | {
      source: "worker_results";
      workerId?: string;
      status?: "ok" | "error" | "skipped";
      policy: "cancel_when_true";
    };
```

This should remain a narrow, explicit control-plane feature:

- the predicate is attached to a delegation intent
- it only short-circuits or cancels delegated work
- it does not decide what the parent should do next

That keeps the design planner-free while still allowing delegated work to
converge automatically when its purpose has already been satisfied elsewhere.

Evaluation timing matters.

The preferred evaluation point is event-driven:

- predicates should be checked where durable runtime evidence is already being
  appended or folded
- they should not depend on ad hoc polling loops as the primary mechanism

Exact placement may vary by implementation phase, but the intended model is
append-triggered or fold-triggered evaluation rather than periodic background
scanning.

### 6. Prefer Shared Evidence Surfaces Over Peer Messaging

The next collaboration step should not be direct child-to-child protocol by
default.

The simpler direction is:

- child runs remain temporary and parent-owned
- child runs may read shared evidence that the parent or runtime has already
  made visible
- conflicts or dependencies are reflected as evidence or merge signals
- the parent remains the explicit interpreter of those signals

This captures most of the value of peer awareness without turning temporary
subagents into a second long-lived agent network.

Important implementation note:

this RFC does not assume that child runs automatically gain arbitrary access to
the parent session tape.

The first practical shared-evidence mechanisms should be:

- explicit parent-provided typed refs
- detached-run context manifests (`delegation-context-manifest.json`) copied
  into isolated child workspaces
- shared read-only workspace artifacts and projection products when the child
  shares the parent workspace root
- explicitly exposed cross-session evidence query surfaces, if and when they
  are introduced

Effectful isolated child runs should continue to rely on explicit refs rather
than ambient assumptions about shared runtime state.

## Why

The problem statements and alternatives below record the design rationale that
led to the current implementation and the remaining follow-up work.

### Problem 1: Static Profiles Encode Too Many Decisions

The current built-in profiles are clean and intentionally narrow, but they are
still static environment bundles. They decide:

- which tools are visible
- which budget defaults apply
- which model hint applies
- how the task is framed

That creates future pressure in two directions:

1. profile proliferation
2. hidden control-plane logic that tries to choose among presets

Stronger models will increasingly want to describe the worker shape they need
instead of selecting from a fixed catalog.

At the same time, those bundles currently perform real safety work through
narrowing and overlay validation. The goal is therefore not to remove
structure. It is to move from static preset objects to thinner, more explicit
shape validation.

### Problem 2: Packet And Outcome Contracts Are Still Too Text-First

Current delegation avoids transcript copying, which is already a major win.
However:

- packet references are still mostly locator strings
- execution hints are primarily prompt-visible hints
- outcomes still center on summary text plus evidence references

That is enough for a first product pass, but it is not the strongest long-term
surface for model-native composition.

### Problem 3: Durable Child Results And Parent Re-Entry Are Split

Current background runs already persist:

- run specs
- live-state metadata
- lifecycle events
- durable outcome artifacts

But the parent-facing result re-entry path is still not as explicit and stable
as the underlying durability substrate.

That means the control plane has stronger durability than the product-facing
handoff contract.

Existing replay infrastructure already reconstructs delegation lifecycle state.
The architectural gap is therefore not "can we recover child runs at all?" but
"how should the parent product surface discover and consume recovered results?"

### Problem 4: Process Lifecycle Is Not The Same As Intent Lifecycle

Longer-running delegated work should eventually stop for one of two reasons:

1. the child finished its own slice
2. the broader parent objective no longer needs that slice

The current lifecycle model handles the first case much better than the
second.

### Problem 5: Peer Coordination Is Tempting, But Easy To Overbuild

As models grow stronger, direct peer communication becomes attractive.
However, Brewva already distinguishes:

- temporary delegated workers
- long-lived addressable A2A agents

That distinction is correct and should not be blurred casually.

The simpler step is to strengthen shared evidence and replayable outcome
handoff before adding direct temporary-worker messaging.

## How It Should Work

## Responsibility Split

The next delegation phase should preserve the current ring split.

### Deliberation / Control Plane

Owns:

- deciding whether to delegate
- choosing boundary and result mode
- resolving optional profile presets into a thinner execution shape
- constructing typed packets
- attaching optional completion predicates
- deciding how child outcomes are interpreted

### Gateway / Session Layer

Owns:

- executing child sessions
- applying inherited-then-narrowed tool surfaces and budget hints
- managing progress, cancellation, timeout, and recovery
- writing durable outcome artifacts and replayable handoff records

### Runtime / Kernel

Owns:

- effect authorization inside child runs
- replay, event durability, and recovery
- rollbackability and patch adoption boundaries
- parent-visible durable references and receipts

The runtime must continue to observe and govern effects. It must not become the
automatic delegation planner.

## End-To-End Flow

### 1. Parent Chooses A Delegation Slice

The parent model or operator decides to delegate a bounded slice of work.

Input shape:

- objective
- boundary
- result mode
- optional hints
- typed references
- optional completion predicate

### 2. Control Plane Resolves Environment

The control plane may:

- use a named preset such as `explore` or `review`
- derive the environment directly from the requested execution shape
- resolve a default profile from `executionShape.resultMode` when no explicit
  profile is provided

In both cases, the important invariant remains:

`final child authority is inherited and then narrowed`

That narrowing must be enforced by an explicit validator even when no named
profile object is present.

Current implementation note:

- `resolveDelegationProfile(...)` resolves profile-or-result-mode defaults
- `resolveDelegationExecutionPlan(...)` produces the shared front-end and
  detached-run execution plan

### 3. Gateway Executes An Isolated Child Run

The gateway reuses the current hosted session substrate:

- read-only runs may share the parent workspace
- effectful patch runs execute in isolated writable state
- effectful child writes still flow through runtime governance
- detached runs write `delegation-context-manifest.json` and copy it into the
  isolated workspace before execution

### 4. Child Emits A Typed Outcome

The child returns a result-mode-specific outcome envelope, not just prose.

Examples:

- exploration returns findings and candidate outputs
- review returns typed findings
- verification returns typed checks
- patch returns patch artifacts and manifests

### 5. Outcome Is Handed Back Through One Of Two Paths

Path A: same-turn continuity

- append a concise narrative summary through supplemental injection

Path B: replayable late-result handoff

- write an outcome handoff record
- update replay-visible handoff state and lifecycle events as the result is
  surfaced
- expose the handoff through session inspection surfaces

The parent still decides whether to:

- read it
- inject it
- merge it
- ignore it
- translate it into another already-defined proposal or task action

### 6. Patch Outcomes Still Use Parent-Controlled Merge

This RFC does not weaken the current patch safety model.

Patch-producing child runs should continue to:

- return patch artifacts or worker results
- require explicit parent merge/apply
- rely on rollback-aware write adoption

### 7. Completion Predicates May End Background Work Early

When configured, a background run may stop once replay-visible evidence proves
the delegated objective has already been satisfied.

This should remain:

- explicit
- narrow
- replay-visible
- non-planner-like

## Compatibility And Migration

The migration should be additive first.

### Phase 1 And Phase 2 Compatibility

- keep `profile` as the existing required public field
- allow named profiles to compile into effective execution shapes internally
- add stronger typed refs and typed outcomes without breaking the current
  profile-based request shape

### Phase 3 Compatibility

Once thin execution shapes are ready, the public request may support either:

- `profile`
- `executionShape`

or both.

Recommended rule:

- at least one of `profile` or `executionShape` must be present
- when both are present, explicit execution shape may only narrow the resolved
  profile-derived shape
- named profiles remain supported as stable presets for backward compatibility

This avoids sentinel profile names and keeps the migration explicit.

## Non-Goals

This RFC does not propose:

1. a kernel-owned delegation planner
2. automatic child-to-child messaging for temporary subagents
3. auto-apply patch adoption
4. repository-level merge or release authority in runtime workflow state
5. removal of effect boundaries, receipts, or budget controls
6. immediate support for autonomous nested subagent trees

Important clarification:

This RFC does not recommend deleting budgeting.
It recommends making execution-shape assembly thinner and more inherited than
preset-specific. Bounded execution remains a core Brewva invariant.

## Alternatives Considered

### Option A: Keep The Current Profile Model And Add More Presets

Pros:

- easy to explain
- low implementation cost

Cons:

- encourages profile explosion
- pushes more orchestration choice into hidden preset selection logic
- keeps delegation contracts too environment-shaped

### Option B: Let The Model Freely Describe Arbitrary Worker Environments

Pros:

- maximum flexibility

Cons:

- easy to widen authority accidentally
- weak reviewability
- poor fit for exact effect governance

### Option C: Thin Execution Shape Plus Optional Presets

Pros:

- preserves reviewability and narrowing
- reduces profile centrality without deleting useful presets
- fits Brewva's current constitutional split

Cons:

- requires new typed contract work
- needs a cleaner replayable handoff path

Recommended: Option C.

### Option D: Add Direct Peer Messaging Between Temporary Subagents

Pros:

- richer collaboration patterns

Cons:

- blurs the distinction between delegated workers and A2A agents
- increases control-plane complexity before packet and outcome contracts are
  fully mature

Recommended status: defer.

## Rollout Plan

### Phase 1: Typed Contracts Without Behavioral Expansion — `done`

- add typed delegation refs (`DelegationRef` with `sourceSessionId`, `hash`)
- add typed mode-specific outcomes (`SubagentOutcomeData` discriminated union)
- add structured outcome extraction (`structured-outcome.ts`)
- keep existing built-in profile names as presets
- keep current child-run isolation and merge semantics

### Phase 2: Replayable Outcome Handoff — `done`

- parent-facing durable outcome handoff records implemented
- handoff state is visible through session inspection and workflow surfaces
- parent turns surface pending background results through
  `[CompletedDelegationOutcomes]`
- `subagent_delivery_surfaced` records when a pending result has been shown to
  the parent
- `HostedDelegationStore.listPendingOutcomes(...)` is the promoted derived
  inbox-style handoff surface

### Phase 3: Thin Execution Shape Promotion — `done`

- `SubagentExecutionShape` added to request surface
- `profile` made optional when `executionShape` is present
- `assertDelegationShapeNarrowing` enforces inherited-then-restricted assembly
- `resolveDelegationProfile` resolves default profile by result mode
- spec schema upgraded to `v3`

### Phase 4: Intent-Level Completion Predicates — `done`

- `DelegationCompletionPredicate` discriminated union implemented
- event-source and worker-result-source predicates supported
- background controller evaluates predicates at spawn and cancels on match
- predicate lifecycle tracked and cleaned up on terminal states

### Future Follow-Up: Budget-First Nested Delegation

If nested delegation is ever promoted later, the primary semantic control
should be budget inheritance and narrowing. Hard depth limits may still exist
as operational guardrails, but they should not be the main conceptual model.

## Validation Signals

Validation should focus on contract clarity and recovery behavior.

- typed packet and outcome contracts have unit and contract coverage
- late child outcomes can be recovered and reattached after restart
- parent-visible handoff state survives compaction and replay
- child runs cannot widen tool surface or authority
- patch outcomes still require explicit parent adoption
- workflow inspection reflects pending delegated work without auto-applying it
- documentation clearly states what is authoritative, replayable, and advisory

Representative checks:

- `bun run check`
- `bun test --timeout 600000`
- `bun run test:docs`
- `bun run format:docs:check`

## Promotion Criteria

This RFC is ready for promotion when:

1. stable docs describe the thinner execution shape and typed outcome contract
2. late-result parent handoff is replay-visible and documented
3. built-in profiles are documented as presets rather than the primary
   conceptual contract
4. workflow and background journey docs explain replayable delegated outcome
   handoff clearly
5. tests prove that delegation remains inherited-then-narrowed rather than
   model-expanded

## Source Anchors

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/proposal-boundary.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/journeys/operator/background-and-parallelism.md`
- `packages/brewva-tools/src/types.ts`
- `packages/brewva-tools/src/subagent-run.ts`
- `packages/brewva-tools/src/workflow-status.ts`
- `packages/brewva-tools/src/subagent-control.ts`
- `packages/brewva-gateway/src/subagents/targets.ts`
- `packages/brewva-gateway/src/subagents/shared.ts`
- `packages/brewva-gateway/src/subagents/prompt.ts`
- `packages/brewva-gateway/src/subagents/orchestrator.ts`
- `packages/brewva-gateway/src/subagents/background-controller.ts`
- `packages/brewva-gateway/src/subagents/background-protocol.ts`
- `packages/brewva-gateway/src/subagents/runner-main.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/events/event-types.ts`
- `packages/brewva-runtime/src/services/parallel.ts`
- `packages/brewva-gateway/src/subagents/structured-outcome.ts`
- `packages/brewva-gateway/src/subagents/protocol.ts`
- `packages/brewva-gateway/src/subagents/delegation-store.ts`
