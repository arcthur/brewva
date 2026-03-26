# Research: Skill-First Delegation and Execution Envelopes

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-26`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/reference/runtime.md`
  - `docs/journeys/background-and-parallelism.md`

## Direct Conclusion

This RFC has now been implemented and is best read as a rationale record plus a
promotion pointer.

The resolved model is:

- `SkillContract`
  - semantic work contract
- `ExecutionEnvelope`
  - execution posture and isolation contract
- `AgentSpec`
  - named composition of skill plus envelope
- `HostedDelegationTarget`
  - runtime materialization of one delegated worker configuration

The public compatibility path proposed for legacy `profile`, `entrySkill`, and
`requiredOutputs` fields was not retained.
The final implementation removed those legacy delegation fields instead of
keeping them as long-lived aliases.

Historical sections below that compare the old `profile` model to the new
design should be read as migration rationale, not as the current public
contract.

Brewva has moved to a skill-first delegation model.

The system should keep three distinct concepts:

- `SkillContract`
  - defines what work means
  - owns intent, outputs, effects, completion rules, and semantic guidance
- `ExecutionEnvelope`
  - defines how delegated work runs
  - owns isolation mode, boundary, model, tool capabilities, and runtime budgets
- `AgentSpec`
  - composes a skill with an envelope
  - provides a named delegated worker configuration without creating a second semantic layer

This RFC recommends that Brewva:

1. keep `skill` and delegated execution separate rather than merging them into one object
2. thin current subagent profiles into execution-envelope or agent-spec concepts
3. remove semantic ownership from profiles, especially `prompt` and `entrySkill`
4. make skill contracts the primary source of delegated semantics and output validation
5. preserve ad hoc objective-only delegation as a fallback for exploratory work
6. keep a transport-level fallback result contract for ad hoc runs that do not name a skill
7. preserve the current parent-controlled authority model for patch adoption, replay, and recovery

In short:

`skills define delegated work; execution envelopes define delegated runtime posture; agent specs compose them`

## Why

### The Current Split Is Directionally Correct

Brewva already has the right high-level separation:

- skills describe semantic work contracts
- delegated runs execute in isolated child sessions
- patch-producing child runs do not mutate the parent workspace directly
- child authority narrows from the parent instead of widening

That separation should not be discarded.

## Problem Statement And Scope

The current delegation model works, but the boundary between `skill` and `subagent profile` is too blurry.

Important current-state clarification:

today, delegated prompt assembly is still profile-first rather than skill-first.

The current delegated prompt is assembled from:

- the selected profile prompt
- packet objective and deliverable fields
- packet constraints, notes, and execution hints
- packet context refs and budget hints
- a generic structured outcome contract keyed by `profile.resultMode`

Current delegated prompt assembly does not directly inject the selected skill markdown body.

Current `entrySkill` behavior is narrower than prompt ownership:

- the child runner activates runtime skill state with `runtime.skills.activate(...)`
- this enables child-side skill lifecycle state and related inspection surfaces
- it does not directly insert the skill markdown body into the delegated prompt
- loading the authored skill body today would still require the child to use the skill-loading path explicitly

That distinction matters.
It is one of the main reasons this RFC exists.

Today, a profile may contain:

- semantic framing via `prompt`
- an implicit task binding via `entrySkill`
- runtime posture via `boundary`
- tool-surface narrowing via `builtinToolNames` and `managedToolNames`
- context defaults via `defaultContextBudget`

At the same time, delegation packets may also contain:

- `activeSkillName`
- `entrySkill`
- `requiredOutputs`
- `preferredSkills`
- `preferredTools`
- `contextBudget`

This creates three related problems:

1. semantic ownership is duplicated across skills, profiles, and packets
2. the profile abstraction has become too heavy and too close to a second skill system
3. stronger delegation workflows will make the overlap more visible, not less visible

The question is no longer whether Brewva should support subagents.
It already does.
The real question is:

`what should own delegated semantics, and what should own delegated execution posture?`

In scope:

- delegated work contracts
- execution-envelope design
- named delegated worker configurations
- migration of current built-in profiles
- delegated prompt assembly
- delegated output validation

Out of scope:

- autonomous nested delegation trees
- peer-to-peer agent mesh as the default temporary-worker model
- changing the parent-controlled patch merge and apply model
- introducing a kernel-owned delegation planner

## Why Change

### 1. The Current Profile Object Mixes Two Kinds Of Authority

Semantic authority should answer:

- what work is being requested
- what outputs are required
- what completion means
- what evidence quality is expected

Execution authority should answer:

- where the child runs
- what it may touch
- what tools it may use
- what model and budget it may consume

Current profiles mix both.
That is manageable while the profile catalog is small, but it does not scale cleanly.

### 2. `entrySkill` Is The Clearest Smell

When a profile can directly preload a skill, the profile stops being only an execution preset.
It becomes:

`a semantic task binding plus a runtime container`

That is too much responsibility for one object.

### 3. Prompt Ownership Is Split

Today, delegated semantics may be authored in multiple places, but only some of them directly affect the child prompt today.

Current prompt-visible sources are:

- profile prompts
- packet objective and required output fields

Current non-prompt semantic sources are:

- skill markdown bodies
- skill contracts and output contracts
- child runtime skill activation state

That creates prompt drift and makes it hard to answer:

`which layer is the source of truth for delegated behavior?`

The answer should be:

- skill body and skill contract own semantic behavior
- envelope contributes only thin executor posture

The current gap is not only conceptual duplication.
It is also mechanical:

`skill body is not yet part of delegated prompt assembly even when a child skill is activated`

### 4. One Skill Should Be Able To Run In Multiple Envelopes

A single semantic task may need different runtime postures:

- a cheap read-only scout
- a stricter reviewer
- a slower higher-reasoning reviewer
- a detached background verifier
- an isolated reversible patch worker

If the execution envelope is folded into the skill definition itself, this reuse becomes awkward.

### 5. `patch-worker` Demonstrates Why The Abstraction Must Stay Split

Some delegated workers are primarily execution constructs rather than semantic constructs.

`patch-worker` is the clearest example:

- isolated workspace
- write-capable tools
- patch capture
- parent-controlled adoption

That is an execution envelope first.
It should not become a semantic skill.

### 6. Industry Direction Favors Composition

Across modern coding-agent products, the stable pattern is converging toward:

- skills or prompts as reusable semantic knowledge units
- agents as runtime containers or named worker configurations
- composition instead of inheritance between the two

Brewva should align with that direction without copying any single product literally.

## Options Considered

### Option A: Keep The Current Profile Model And Tighten Documentation Only

Approach:

- keep profiles as the main delegated abstraction
- document the difference from skills more clearly

Pros:

- lowest migration cost
- preserves current tool and profile contracts

Cons:

- semantic duplication remains
- prompt drift remains
- profile continues to look like a second skill system

Decision:

- rejected as the long-term design

### Option B: Merge Envelopes Into Skills Completely

Approach:

- make every delegated task a skill
- embed execution-envelope details directly into the skill contract

Pros:

- simpler story at first glance
- fewer top-level concepts

Cons:

- over-couples semantics and runtime posture
- makes one-skill-many-envelopes reuse harder
- treats execution-specific workers such as isolated patch runners as if they were semantic skills

Decision:

- rejected as the primary architecture

### Option C: Skill-First Delegation With Separate Execution Envelopes

Approach:

- make skills the primary semantic contract
- thin profiles into execution envelopes
- add named agent specs that compose skill plus envelope
- preserve objective-only ad hoc delegation as a fallback

Pros:

- clear ownership boundaries
- supports both authored specialists and ad hoc exploration
- preserves executor reuse
- aligns with Brewva's current parent-controlled authority model

Cons:

- requires contract migration
- introduces one additional named composition layer

Decision:

- recommended

## Proposed Model

### 1. `SkillContract`

`SkillContract` remains the first-class semantic unit.

It owns:

- intent and work semantics
- output contracts
- effect expectations and ceilings
- completion expectations
- semantic guidance and authored behavior
- capability-level tool requirements

Illustrative shape:

```ts
export interface SkillContract {
  name: string;
  intent: {
    summary: string;
    outputs?: string[];
    outputContracts?: Record<string, unknown>;
  };
  effects?: {
    allowed?: string[];
    denied?: string[];
  };
  completion?: {
    policy?: string;
  };
  executionHints?: {
    requiredCapabilities?: string[];
    preferredCapabilities?: string[];
  };
}
```

### 2. `ExecutionEnvelope`

`ExecutionEnvelope` becomes the runtime posture object.

It owns:

- boundary
- model hint
- builtin tool allowlist
- managed tool capability set
- managed tool mode
- context and turn budgets
- isolation mode
- detached or foreground execution posture

Illustrative shape:

```ts
export interface ExecutionEnvelope {
  name: string;
  boundary: "safe" | "effectful";
  model?: string;
  builtinToolNames?: Array<"read" | "edit" | "write">;
  managedToolCapabilities?: string[];
  managedToolMode?: "direct" | "extension";
  defaultContextBudget?: {
    maxInjectionTokens?: number;
    maxTurnTokens?: number;
  };
  isolationMode?: "shared_workspace" | "isolated_workspace";
}
```

### 3. `AgentSpec`

`AgentSpec` becomes the named composition object.

It owns:

- which skill to run by default
- which execution envelope to use
- optional thin executor-level preamble

Illustrative shape:

```ts
export interface AgentSpec {
  name: string;
  description: string;
  skillName?: string;
  envelope: string;
  executorPreamble?: string;
}
```

Important constraint:

`executorPreamble` must remain executor-scoped.
It may explain runtime posture, but it must not replace the semantic role of the skill body.
It should also be length-limited and validated as infrastructure-only text so it does not become `profile.prompt 2.0`.

### 4. `DelegationRunRequest`

Delegation should support both authored and ad hoc flows.

Illustrative shape:

```ts
export interface DelegationTask {
  label?: string;
  objective: string;
  deliverable?: string;
  constraints?: string[];
  contextRefs?: DelegationRef[];
}

export interface DelegationRunRequest {
  mode: "single" | "parallel";
  skillName?: string;
  envelope?: string;
  agentSpec?: string;
  objective?: string;
  deliverable?: string;
  constraints?: string[];
  contextRefs?: DelegationRef[];
  fallbackResultMode?: "exploration" | "review" | "verification" | "patch";
  tasks?: DelegationTask[];
  delivery?: {
    returnMode: "text_only" | "supplemental";
    returnLabel?: string;
    returnScopeId?: string;
  };
}
```

Rules:

- `agentSpec` composes a skill and envelope in one named reusable unit
- `skillName + envelope` is the explicit structured path
- `objective + envelope` remains allowed for ad hoc exploration
- `mode=parallel` uses one shared semantic and envelope configuration with per-task objective slices
- `objective` without `skillName` must not silently claim skill-level output validation
- ad hoc runs without `skillName` must carry a transport-level fallback result contract through `fallbackResultMode`, unless it is supplied by a named ad hoc agent spec

### 5. Ad Hoc Result Contracts

Ad hoc delegation must still produce machine-readable child outcomes.

If `skillName` is absent, Brewva still needs a schema owner for:

- structured child summaries
- result parsing
- parent-side distillation
- replayable delivery surfaces

The current system uses `profile.resultMode` for that role.
If envelopes stop carrying semantic ownership, the result-mode fallback must move elsewhere.

Recommended rule:

- `skillName` present
  - output contracts come from the skill
  - generic result-mode parsing is secondary or compatibility-only
- `skillName` absent
  - `fallbackResultMode` is required unless a named ad hoc agent spec provides it
  - `fallbackResultMode` is a transport contract only, not the semantic contract for the work

This keeps ad hoc delegation useful without making the envelope object semantic again.

## How

### How Delegated Prompt Assembly Changes

Current state:

1. profile prompt
2. packet objective and related packet fields
3. context refs and budget hints
4. generic structured outcome instructions keyed by result mode

Current state does not directly inject skill body text into the child prompt, even when `entrySkill` activates child runtime skill state.

Delegated prompt assembly should become layered:

1. executor preamble from envelope or agent spec
2. semantic body from the selected skill
3. task-specific objective and constraints from the run request
4. context refs and delivery requirements from the run request
5. output contract rendering from the skill, or fallback result-mode rendering for ad hoc runs

The profile prompt should no longer be the primary semantic payload.

The delegated child should receive:

- semantic guidance from the skill
- runtime posture from the envelope
- task-specific data from the packet

That means the future skill-first path should not require the child model to make a follow-up `skill_load` call just to read its own authored instructions.

### How Child Skill Lifecycle Changes

This RFC recommends a narrow child-skill model rather than a second authoritative skill workflow.

Recommended behavior when `skillName` is present:

1. the runner resolves the skill contract before launching the child
2. the runner injects the skill body and rendered output contract directly into the child prompt
3. the child runtime may still mark that skill as active for inspection and compatibility surfaces
4. the child is not required to call `skill_complete`
5. the runner performs final delegated output validation against the skill contract after the child returns
6. the parent session remains the only authoritative owner of top-level skill progression and patch adoption

This keeps child skill usage visible without creating a second independent semantic lifecycle.

Recommended behavior when `skillName` is absent:

- no child runtime skill activation is required
- validation uses `fallbackResultMode` transport rules only
- no skill-derived output contract is assumed

### How Tool Resolution Changes

Current profiles manually enumerate large managed-tool lists.
That should be replaced with a capability-driven path.

Recommended direction:

1. skills declare required or preferred tool capabilities
2. envelopes declare capability ceilings and runtime boundaries
3. runtime resolves actual tool names from capability sets under the selected boundary

This avoids long static profile tool lists and reduces drift when the tool catalog changes.

### How Output Validation Changes

When `skillName` is present:

- delegated outputs should validate against the skill's declared output contract
- result parsing should prefer skill-derived contracts over generic profile-derived result modes

When `skillName` is absent:

- Brewva may still use generic delegation outcome schemas such as exploration, review, verification, or patch
- those schemas remain fallback transport contracts, not the primary semantic contract system

### How Built-In Profiles Evolve

Current built-ins should split into two categories.

Semantic candidates that should become internal or core skills over time:

- `explore`
- `plan`
- `review`
- `verification`

Execution or compatibility candidates that should remain envelopes or named agent specs:

- `general`
- `patch-worker`
- generic read-only scout envelopes
- generic detached verification envelopes

Recommended near-term treatment:

- `review` and `verification`
  - migrate first because they have the clearest output-contract story
- `plan`
  - migrate after stable review and verification semantics exist
- `explore`
  - can become an internal skill later, but does not need to block the core migration
- `general`
  - should become the default named ad hoc agent spec or compatibility preset for safe objective-only delegation
- `patch-worker`
  - stays execution-first and should not become a semantic skill

The migration goal is not:

`every built-in profile becomes a skill`

The migration goal is:

`semantic built-ins become skills; runtime postures become envelopes`

### How Custom Delegated Workers Evolve

Workspace customization should move toward named agent specs.

Recommended compatibility path:

- keep `.brewva/subagents/*.json` working during migration
- reinterpret that directory as named delegated worker or agent-spec configuration
- require a clear distinction between:
  - `skillName`
  - `envelope`
  - envelope overrides
- preserve current narrowing-only override rules for boundary, tool surface, and budget ceilings

Recommended precedence rules:

- `agentSpec`
  - supplies defaults
- explicit request fields
  - may fill omitted values
  - may narrow envelope-level values where narrowing is well-defined
- conflicting semantic bindings
  - are invalid rather than silently merged

In particular:

- if `agentSpec.skillName` and `request.skillName` are both present and differ, the request should fail fast
- envelope overrides must continue obeying narrowing-only invariants
- request-level boundary or budget hints may narrow but must not widen the selected envelope

Longer term, Brewva may rename this storage to a more accurate path such as:

- `.brewva/agents/`

but a storage rename is not required for the conceptual fix.

### How Parent Authority Stays Intact

This RFC does not change the current authority model.

The parent session remains the source of truth for:

- active skill lifecycle
- patch adoption
- durable commitments
- replay-visible delegation history

Patch-producing child runs must continue returning `WorkerResult` artifacts and patch manifests for parent-controlled merge and apply.

## Migration Plan (Historical)

The phased plan below is retained as the implementation record. It is no
longer pending work.

### Phase 1: Thin The Current Profile Contract

- deprecate `profile.entrySkill`
- deprecate semantic-heavy `profile.prompt`
- add `skillName?` to delegation requests
- keep `profile` support as a compatibility preset path

### Phase 2: Introduce Envelope And Agent-Spec Vocabulary

- introduce `ExecutionEnvelope`
- introduce `AgentSpec`
- allow named delegated workers to compose `skillName + envelope`
- keep compatibility aliases from existing profile names

### Phase 3: Move Semantic Built-Ins Into Skills

- create internal or core skills for stable semantic delegates such as review and verification first
- derive delegated output validation from skill contracts when present
- inject skill body content directly into delegated prompt assembly
- retain generic fallback result schemas for ad hoc runs

### Phase 4: Move Tool Resolution To Capabilities

- let skills request capabilities rather than concrete tool lists
- let envelopes cap available capabilities under boundary and isolation rules
- resolve actual managed tool names during session creation

This phase is intentionally separable from the core semantic-envelope split and may ship as a follow-on RFC if the migration should stay narrower.

### Phase 5: Narrow Legacy Profile Usage

- keep legacy profiles as thin named presets during transition
- remove semantic ownership from them
- eventually reclassify them as agent specs or envelopes only

## Source Anchors

- `packages/brewva-gateway/src/subagents/targets.ts`
- `packages/brewva-gateway/src/subagents/prompt.ts`
- `packages/brewva-gateway/src/subagents/protocol.ts`
- `packages/brewva-gateway/src/subagents/structured-outcome.ts`
- `packages/brewva-gateway/src/subagents/shared.ts`
- `packages/brewva-gateway/src/subagents/orchestrator.ts`
- `packages/brewva-gateway/src/subagents/runner-main.ts`
- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `packages/brewva-tools/src/types.ts`
- `packages/brewva-tools/src/subagent-run.ts`
- `packages/brewva-tools/src/subagent-control.ts`
- `packages/brewva-tools/src/index.ts`
- `packages/brewva-tools/src/surface.ts`
- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
- `docs/reference/skills.md`
- `docs/reference/tools.md`
- `docs/reference/runtime.md`
- `docs/journeys/background-and-parallelism.md`

## Validation Signals

The proposal is moving in the right direction when:

- delegated semantics come from one primary authored source rather than three overlapping sources
- one skill can run under multiple envelopes without cloning the skill definition
- executor-only workers such as isolated patch runners no longer pretend to be semantic skills
- managed tool resolution becomes capability-driven rather than hand-maintained long lists
- ad hoc delegation remains possible without requiring every exploratory task to become a skill
- parent-controlled patch adoption and replay invariants remain unchanged

## Implementation Resolution

The RFC is considered implemented because the following are now true:

1. `skillName` is a first-class delegated input.
2. legacy `profile`, `entrySkill`, and `requiredOutputs` delegation fields are removed from the public request contract.
3. delegated semantic prompt assembly is skill-first and directly injects authored skill content when a delegated skill is selected.
4. ad hoc delegated runs use explicit `fallbackResultMode` semantics rather than semantic profile ownership.
5. child skill lifecycle and output validation semantics are explicit and regression-tested.
6. named delegation targets use `ExecutionEnvelope`, `AgentSpec`, and `HostedDelegationTarget` terminology.
7. stable docs explain the relationship among skills, envelopes, named delegated workers, and parent-controlled adoption.

## Resolved Decisions

1. Naming
   - use `ExecutionEnvelope` and `AgentSpec` as the current delegation composition names
   - use `HostedDelegationTarget` as the runtime materialization type
   - do not keep `profile` as a public compatibility alias
2. Child skill lifecycle
   - child runtime skill activation remains visible
   - delegated semantics and authored skill content are injected by the runner rather than delegated to a child-side follow-up load
3. Ad hoc fallback
   - ad hoc delegation uses explicit `fallbackResultMode`
   - the default ad hoc path resolves through the `general` target model rather than through legacy profile semantics
4. Storage layout
   - keep `.brewva/subagents/` for now
   - treat future directory renaming as optional follow-on cleanup rather than part of the core delegation model

## Remaining Follow-on Questions

No blocking architectural questions remain for the implemented delegation
model.

Possible follow-on work, if pursued, should be tracked in separate RFCs:

1. capability-driven tool resolution beyond the current envelope and skill hint model
2. optional storage rename from `.brewva/subagents/` to a more explicit path such as `.brewva/agents/`
3. Should capability-based tool resolution remain in this migration track, or be split into a narrower follow-on RFC once the semantic-envelope split is implemented?

## Promotion Notes

If accepted, this RFC should eventually produce:

- a thinner delegation request contract
- a clearer skill reference contract
- a clearer executor-envelope contract
- a stable explanation of how Brewva differs from flat task-spawn models while still supporting ad hoc delegation
