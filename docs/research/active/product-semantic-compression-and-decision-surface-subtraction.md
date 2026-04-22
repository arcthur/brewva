# Research: Product Semantic Compression And Decision Surface Subtraction

## Document Metadata

- Status: `active`
- Owner: runtime, gateway, and product-surface maintainers
- Last reviewed: `2026-04-22`
- Promotion target:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/tools.md`
  - `docs/journeys/operator/interactive-session.md`

## Problem Statement And Scope Boundaries

Brewva has strong underlying capability, but the default product path exposes too
many adjacent decision surfaces to the model and operator at the same time.

A single task can require the operator or model to reason across:

- natural-language intent
- `TaskSpec`
- skill recommendation
- `skill_load`
- `workflow_status`
- readiness and consumed outputs
- `recall_search`
- `knowledge_search`
- `output_search`
- tape and ledger inspection
- advisory posture
- verified evidence
- repository precedent
- projection state
- verification, acceptance, and ship posture

Most of these surfaces are legitimate internal boundaries. The problem is not
that Brewva has too many mechanisms. The problem is that too many mechanisms
remain first-order choices in the product-facing path.

This creates avoidable miss paths:

1. The model may pick the semantically similar skill at the wrong time.
2. The model may search the wrong evidence family.
3. Weak session-local evidence may outrank stronger repository precedent.
4. Advisory state may be treated as truth, or ignored entirely.
5. The task may finish too early because completion, verification, and
   acceptance are not presented as one closure decision.
6. The operator may interpret architectural terms as operational steps.

This note proposes a long-term subtraction strategy for the product-facing
semantic surface. It does not propose weakening kernel boundaries, collapsing
source typing, auto-activating skills, or reintroducing hidden runtime planners.

## Relationship To Existing Research

This note extends the subtraction direction already promoted in:

- `docs/research/promoted/rfc-boundary-first-subtraction-and-model-native-recovery.md`
- `docs/research/promoted/rfc-kernel-first-subtraction-and-control-plane-deferral.md`
- `docs/research/promoted/rfc-authority-surface-narrowing-and-runtime-facade-compression.md`
- `docs/research/promoted/rfc-model-native-product-reconstruction-and-closure-vnext.md`
- `docs/research/promoted/rfc-skill-contract-layering-project-context-and-explicit-activation.md`
- `docs/research/promoted/rfc-skill-metadata-as-runtime-contract-and-routing-substrate.md`
- `docs/research/promoted/rfc-skill-surface-compression-and-project-guidance-boundaries.md`
- `docs/research/promoted/rfc-recall-first-compounding-intelligence-and-experience-products.md`
- `docs/research/promoted/rfc-repository-native-compound-knowledge-and-review-ensemble.md`
- `docs/research/promoted/rfc-context-dependency-layering-and-admission-lanes.md`

The prior RFCs establish why certain complexity must remain:

- the kernel governs effects, receipts, replay, rollback, and verification
- model-native intelligence should not be replaced by runtime-owned thought paths
- skill activation remains explicit through `skill_load`
- memory and precedent remain advisory unless promoted through explicit evidence
- context governance must remain rebuildable and provenance-bearing
- future surface growth needs a non-positive surface budget unless justified by
  a bounded debt owner and re-evaluation trigger

This note addresses a different layer:

`How should those boundaries be presented so the default path has fewer ways to
miss?`

## Core Thesis

Brewva should simplify by subtracting product-visible decision points, not by
deleting authority boundaries.

The long-term default product vocabulary should use five labels:

- `Task`
- `Skill`
- `Search`
- `Evidence`
- `Finish`

Everything else should either:

- remain an internal implementation boundary
- be visible only as provenance under one of those five labels
- require an explicit advanced inspection path.

This is not a proposal to make Brewva less capable. It is a proposal to make the
correct path lower-friction and the common wrong paths harder to enter.

The five labels are presentation labels, not new kernel nouns. They are also
interpretation dimensions, not ordered workflow stages.

## Design Taste

The subtraction bar should be stricter than "fewer screens" or "shorter
prompts." A change counts as real subtraction only when it removes an operating
choice from the default path without moving that choice into hidden heuristics.

Useful subtraction:

- removes a model/operator decision point
- preserves source typing and authority provenance
- makes the next action clearer without making it automatic
- improves eval results or reduces repeated clarification turns
- keeps failure states inspectable

False subtraction:

- renames several concepts into one label while keeping the same choices
- hides routing behind an uninspectable planner
- implements `Task -> Skill -> Search -> Evidence -> Finish` as a required
  stage machine
- treats advisory memory as replay truth
- auto-loads skills on behalf of the model
- collapses repository precedent and session-local memory into one undifferentiated
  recall pool
- adds `runtime.task_spine.*`, `runtime.evidence.*`, or any equivalent object
  namespace for labels that should remain presentation-only
- adds a new surface that merely explains existing surfaces without retiring any
  default-path interpretation burden

## Decision Options

### Option A: Add Better Labels To Existing Surfaces

This option keeps all existing surfaces visible and adds friendlier labels,
tooltips, or documentation.

Benefits:

- low implementation cost
- preserves all current behavior
- improves some operator comprehension

Costs:

- does not reduce routing ambiguity
- leaves the model to decide which surface to consult first
- does not address current recall-ranking evidence conflicts
- adds explanation rather than subtraction

Assessment:

- useful as a short-term readability aid
- insufficient as the long-term strategy

### Option B: Introduce A Hidden Product Planner

This option introduces a planner-like control layer that decides task shape,
skill routing, retrieval source, and closure status before the model acts.

Benefits:

- can appear simpler to the operator
- may improve some first-turn routing cases

Costs:

- conflicts with the promoted boundary-first subtraction direction
- risks recreating judge-based routing and chain-control behavior under a new
  name
- makes failures harder to inspect because path choice moves into hidden
  orchestration
- pressures advisory state into control authority

Assessment:

- rejected

### Option C: Add Non-Authoritative Product Semantic Labels

This option keeps existing authority and source boundaries intact, but presents
the default path through five product labels: `Task`, `Skill`, `Search`,
`Evidence`, and `Finish`.

The labels are not kernel surfaces, runtime objects, or a second planner. They
are explicit, provenance-bearing presentation over existing runtime, gateway,
recall, skill, and workflow state.

Benefits:

- preserves kernel and recall invariants
- reduces default-path cognitive load
- makes routing failures diagnosable instead of invisible
- creates a consistent rendering vocabulary for missing inputs, evidence
  quality, and closure gaps
- can be validated with existing recall, skill-routing, docs, and workflow tests

Costs:

- requires careful implementation to avoid becoming planner-by-another-name
- needs stable provenance labels and quality gates
- may require prompt/context reshaping and operator UI work

Assessment:

- recommended

## Proposed Long-Term Contract

### 1. Preserve Protected Complexity

The following complexity is structural and should not be removed by product
compression:

- kernel authority, receipts, replay, rollback, WAL, and verification evidence
- explicit effect governance and approval boundaries
- source-typed recall families
- repository-native precedent under `docs/solutions/**`
- explicit `skill_load` activation
- raw `skill_completed` producer outputs as durable evidence
- working projection as rebuildable state, not truth
- advisory memory as advisory context, not compact baseline or replay source
- context provider descriptors as the metadata truth for admission

Product simplification must read from these boundaries. It must not replace them.

### 2. Compress The Default Product Vocabulary

The default model/operator path should use five labels.

These labels must obey two hard rules:

1. They are presentation labels, not object layers.
2. They are interpretation dimensions, not a linear stage machine.

The labels may be rendered together, separately, or omitted when irrelevant to
the current turn. `Evidence` is cross-cutting. `Search` may appear before a skill
choice, after a skill output, or during closure. `Finish` is a closure view, not
the final button in a required workflow.

Forbidden implementation shapes:

- no `runtime.task_spine.*`
- no `runtime.evidence.*`
- no equivalent runtime namespace for the five labels
- no new durable object family for the labels
- no second inspect truth surface
- no new workflow stage machine that requires the labels to appear in order
- no model-writable durable hint that feeds later routing through the labels

The labels may render existing truth, projection, and advisory surfaces. They
must not become truth.

#### `Task`

The interpreted unit of work.

The `Task` surface answers:

- what goal is being pursued
- which targets are in scope
- which constraints matter
- what expected behavior or acceptance signal is implied
- what is missing before reliable execution

It may be derived from prompt text, existing `TaskSpec`, workflow state, and
active skill context. It must not become a hidden durable planner state.

If durable task truth is needed, it should remain in the existing task and
receipt mechanisms rather than in a new product-only object.

#### `Skill`

The semantic execution contract that should own the next bounded work unit.

The `Skill` surface answers:

- which skill is recommended now
- why it is recommended
- which candidates were rejected and why
- whether the candidate is cold-start aligned or artifact-ready
- which required inputs are present or missing
- what would become shallow if the skill were loaded immediately

This is a diagnostic surface over skill diagnosis, readiness, consumed outputs,
and workflow posture. It must not auto-activate the skill.

#### `Search`

The intent-routed retrieval surface.

The `Search` surface answers:

- whether the task needs prior work, repository precedent, current-session
  evidence, tool output, or runtime receipts
- which underlying retrieval surface was used
- which source families were included or excluded
- whether the result is sufficient for the current decision

It may route reads across `recall_search`, `knowledge_search`, `output_search`,
and explicit inspect surfaces. It must preserve source family and scope labels.

It must not introduce a unified write surface or erase the distinction between
memory, precedent, tape evidence, and generated artifacts.

#### `Evidence`

The provenance-bearing support for the current decision.

The `Evidence` surface answers:

- whether a claim is kernel truth, verified evidence, repository precedent,
  advisory posture, session-local memory, or working projection
- whether freshness or scope should reduce trust
- whether stronger evidence should displace weaker evidence
- which evidence is missing before acting

Evidence labels are presentation metadata over existing source contracts. They
must not promote advisory state into authority.

#### `Finish`

The closure surface for deciding whether the work is deliverable.

The `Finish` surface answers:

- what was completed
- which evidence verifies it
- what remains unverified
- whether operator acceptance is still required
- whether the state is technically complete, ready for acceptance, or
  deliverable

This surface compresses completion, verification, acceptance, and ship posture
into one product decision while keeping their internal authority boundaries
separate.

### 3. Replace Recommendations With Diagnostics

Recommendation-only surfaces are too weak for high hit rate.

A recommendation says:

`Use this skill.`

A diagnostic says:

- `Use this skill because ...`
- `Do not use these nearby skills because ...`
- `Required input is missing here ...`
- `If loaded now, the most likely shallow output is ...`
- `This recommendation is based on prompt text, TaskSpec, consumed outputs, and
workflow posture in this order ...`

The long-term product path should favor diagnostics over recommendations
wherever routing affects quality.

### 4. Route Search By Intent, Not Tool Name

The default product path should not ask the model to decide whether to use
`recall_search`, `knowledge_search`, `output_search`, tape inspection, or
ledger inspection as separate first-order choices.

The model should express retrieval intent:

- previous similar work
- repository precedent
- current-session evidence
- recent command output
- durable runtime receipts

The system should map that intent to the appropriate read surface and disclose
the mapping in the result.

This is still model-native. The model chooses the information need. Brewva
chooses the lowest-authority-preserving retrieval surface for that need.

### 5. Make Evidence Strength Explicit

Recall and retrieval quality depends on more than semantic similarity.

Ranking should account for:

- source family
- evidence strength
- scope match
- freshness
- contradiction risk
- query intent

A weak prior-session task event should not outrank a directly relevant
repository precedent when the query intent is precedent-seeking. Conversely,
session-local runtime evidence may outrank repository precedent when the current
question is "what just happened?"

This requires evidence strength below the current broad source-family tier. The
source family alone is not precise enough.

### 6. Keep Advanced Surfaces Inspectable, Not Default

The following surfaces should remain available, but should not be the default
mental model:

- rings
- planes
- lanes
- phases
- overlays
- provider profiles
- projection internals
- tape and ledger details
- workflow artifact families
- context admission lanes

These concepts are valuable for maintainers and incident analysis. They should
not be required to understand the common path.

### 7. Freeze Vocabulary Growth

Future work should not add more product-facing vocabulary unless it removes a
larger concept or enforces a previously documentation-only rule.

New names need a deletion ledger:

- what existing concept is removed from the default path?
- what decision point is eliminated?
- what source or authority boundary remains visible?
- what test or eval proves hit-rate improvement?

### 8. Require A Subtraction Ledger For Every Product Block

Adding a block that merely explains the current state is not enough.

Every implementation step that adds a product-facing block must name what it
retires from the default path:

- which raw posture, recommendation, readiness, or workflow block becomes hidden
  from the default prompt path
- which surface remains available only through explicit advanced inspection
- which surface is downgraded from default context to on-demand context
- which existing operator interpretation burden is removed
- which eval, test, or trace proves the old burden no longer appears in the
  default path

If an implementation cannot retire, hide, or downgrade an existing default-path
burden, it should not count as subtraction and should not satisfy promotion
criteria.

## Source Anchors

Architecture and research anchors:

- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/research/README.md`
- `docs/research/promoted/rfc-boundary-first-subtraction-and-model-native-recovery.md`
- `docs/research/promoted/rfc-model-native-product-reconstruction-and-closure-vnext.md`
- `docs/research/promoted/rfc-recall-first-compounding-intelligence-and-experience-products.md`
- `docs/research/promoted/rfc-repository-native-compound-knowledge-and-review-ensemble.md`
- `docs/research/promoted/rfc-skill-contract-layering-project-context-and-explicit-activation.md`
- `docs/research/promoted/rfc-skill-metadata-as-runtime-contract-and-routing-substrate.md`
- `docs/research/promoted/rfc-skill-surface-compression-and-project-guidance-boundaries.md`
- `docs/research/promoted/rfc-context-dependency-layering-and-admission-lanes.md`

Runtime and gateway anchors:

- `packages/brewva-recall/src/broker.ts`
- `packages/brewva-recall/src/context-provider.ts`
- `packages/brewva-gateway/src/runtime-plugins/skill-first.ts`
- `packages/brewva-runtime/src/skills/readiness.ts`
- `packages/brewva-runtime/src/context/arena.ts`
- `packages/brewva-runtime/src/context/provider.ts`
- `packages/brewva-runtime/src/services/context.ts`
- `packages/brewva-tools/src/skill-load.ts`
- `packages/brewva-tools/src/recall.ts`

Evaluation anchors:

- `test/eval/scenarios/recall-precedent-outranks-advisory.yaml`
- `test/eval/datasets/recall-precedent-outranks-advisory.yaml`
- `test/eval/scenarios/recall-cross-session-broker.yaml`
- `test/eval/scenarios/recall-session-local-preserved.yaml`
- `test/eval/scenarios/recall-stale-displaced-by-fresh-evidence.yaml`

## Implementation Strategy

### Phase 0: Stabilize Evidence Ranking Before Adding Product Surfaces

Fix the recall evidence-strength issue before adding a larger product shell.

Implementation status: implemented on `2026-04-22`.

Required direction:

- split broad source-family tiering from evidence-strength scoring
- distinguish strong runtime evidence from weak task-event evidence
- make query intent affect source-family ordering
- wire the recall intent through the existing `recall_search` tool and recall
  context provider so the ranking signal is active on the hosted default path
- keep source typing visible in results
- preserve repository-root scope isolation
- keep `prior_work` as a neutral broker default rather than an active boost; it
  should mean "broad prior-work recall" without silently preferring one evidence
  family
- keep raw recent tool output outside broker recall intent; it belongs to the
  existing `output_search` artifact surface until Phase 5 introduces the product
  search-intent presentation layer

Primary validation:

- `recall-precedent-outranks-advisory` must pass
- `recall-current-session-intent-top1` must show positive top-1 gain from
  current-session intent over generic broker ranking
- future ranking calibration should add a scenario where current-session weak
  task progress competes with cross-session strong receipts before changing the
  source/strength weights; this is an intent trade-off, not a schema gap
- existing recall scenarios must not regress
- broker precision and useful-recall rate must not decline on the recall eval
  corpus

Rationale:

If retrieval can return the wrong evidence family at the top, a higher-level
product shell will only make the wrong answer easier to trust.

### Phase 1: Upgrade Skill Recommendation To Skill Diagnosis

Replace or augment the current recommendation output with a diagnostic shape.

Implementation status: implemented on `2026-04-22`; the old hosted default
recommendation block and event name are retired. The hosted default diagnosis
block is intentionally compressed to selected skill, readiness, missing inputs,
and shortest next action; full selected/rejected/risk detail remains in the
receipt and inspect payload.

This phase should come early because skill diagnosis is closest to the current
hit-rate problem, is grounded in existing recommendation/readiness code, and has
the lowest risk of creating a broad new abstraction.

The diagnostic should include:

- selected candidate
- selection rationale
- nearest rejected candidates
- cold-start versus artifact-aware basis
- missing `requires` or consumed outputs
- shallow-output risk if loaded now
- recommended shortest next action

Rules:

- still recommend `skill_load` rather than activating automatically
- keep missing `requires` advisory unless lifecycle gates require otherwise
- use existing readiness and consumed-output surfaces instead of creating a
  second skill lifecycle model
- retire or downgrade the previous default-path recommendation block when the
  diagnostic block is introduced

### Phase 2: Add A Unified Finish Surface

Compress closure into one product decision.

Implementation status: implemented on `2026-04-22` as a non-authoritative
`FinishView` rendered by `workflow_status`.

This phase should precede a generic interpretation block because closure is
already a known split across completion, verification, acceptance, and delivery
posture. It can reduce operator/model ambiguity without introducing a broad
turn-level abstraction.

The finish surface should include:

- completed work
- verification evidence
- missing evidence
- acceptance requirement
- delivery posture
- residual risks

Rules:

- keep `skill_complete` producer evidence separate from verification
- keep acceptance operator-visible
- do not let the model self-approve acceptance
- do not collapse release fitness into runtime authority
- retire or downgrade overlapping default-path closure/posture blocks when the
  finish surface is introduced

### Phase 3: Standardize Evidence Labels As Presentation Metadata

Standardize product-facing trust labels without changing authority semantics.

Implementation status: implemented on `2026-04-22` for recall/tool/context
rendering and workflow presentation. Kernel authority semantics are unchanged.

Recommended labels:

- `Kernel truth`
- `Verified evidence`
- `Repository precedent`
- `Advisory posture`
- `Session-local memory`
- `Working projection`

Rules:

- labels are presentation metadata
- labels must be backed by source family and provenance
- labels must not widen authority or change replay behavior
- labels should be available to model-facing context and operator presentation
  only as renderings over existing evidence sources
- labels must not create `runtime.evidence.*` or a second inspect truth surface

### Phase 4: Introduce A Bounded Turn Interpretation Block

Implementation status: intentionally deferred. The existing `recall_search`
tool and recall context provider now pass a typed recall intent into broker
ranking, but this is not the general search-intent presentation layer described
below.

Create a bounded, non-authoritative interpretation block in the hosted product
path.

This phase should wait until skill diagnosis and finish have already removed
concrete default-path burdens. Otherwise, the block is likely to become
explanation accretion instead of subtraction.

It should include:

- task goal
- targets
- constraints
- expected behavior or closure signal
- missing inputs
- likely next owner
- evidence needed before effectful action

It should not be required to render all five labels on every turn. Search may be
irrelevant. Finish may be absent. Evidence may appear inside skill diagnosis or
finish rather than as a separate block.

Rules:

- no new durable task truth
- no hidden next-step controller
- no auto skill activation
- no model-writable durable hints that feed later routing
- no new runtime object layer for the five labels
- no second inspect truth
- no required `Task -> Skill -> Search -> Evidence -> Finish` sequence
- launch requires a subtraction ledger naming the existing default blocks that
  become retired, hidden, or on-demand
- provenance must identify whether the interpretation came from prompt text,
  `TaskSpec`, active skill, workflow posture, or prior evidence

### Phase 5: Add Intent-Routed Search Presentation

Implementation status: intentionally deferred.

Introduce a search routing presentation layer that maps information need to the
existing read surfaces.

This phase comes after the narrower skill and finish improvements because a
general search-intent surface can otherwise become another broad abstraction
layer. Its promotion should depend on evidence that the model is currently
choosing the wrong search family or overusing raw inspect paths.

The minimum supported intents are:

- prior similar work
- repository precedent
- current session evidence
- recent tool output
- durable runtime receipts

This product-level list is broader than the current broker-level
`RecallSearchIntent` enum. In the current implementation, `recall_search` only
accepts broker recall intents: `prior_work`, `repository_precedent`,
`current_session_evidence`, and `durable_runtime_receipts`. The `recent tool
output` product intent must route to `output_search` rather than being modeled as
another recall source family or a durable recall object.

Rules:

- no unified materialization or write path
- no collapse of memory and precedent
- no hidden default precedent injection into every hosted turn
- result blocks must preserve source family, scope, freshness, and trust label

### Phase 6: Promote Stable Semantics

Implementation status: partially complete for phases 0-3 stable references.
Full promotion remains blocked on phases 4-5 and product-hit-rate measurement.

Once validation passes, promote the accepted product semantics into stable docs:

- update `docs/architecture/cognitive-product-architecture.md`
- update `docs/reference/skill-routing.md`
- update `docs/reference/context-composer.md`
- update `docs/reference/tools.md`
- add or update an operator journey document for the five-label mental model
- reduce this research note to a promoted status pointer

## Validation Signals

### Recall Quality

- `bun run eval:recall`
- `bun run eval:recall:summary`
- scenario-level pass for `recall-precedent-outranks-advisory`
- no regression for session-local recall preservation
- no regression for stale-evidence displacement
- no increase in harmful recall rate

### Skill Routing Quality

- routed candidate explanations include selected and rejected candidates
- cold-start and artifact-aware basis are distinguishable
- missing `requires` are visible before `skill_load`
- skill routing tests still prove explicit activation
- no reintroduction of judge-based preselection, cascade, or chain-control

### Product Hit Rate

Track at least:

- first-turn correct skill recommendation rate
- search-intent correctness rate
- evidence-family correctness rate
- number of turns before first useful evidence
- number of turns before first effectful action when effectful action is needed
- premature-finish rate
- over-verification rate

### Authority Safety

Regression coverage must prove:

- no advisory memory becomes replay truth
- no product interpretation block mutates kernel state
- no skill auto-activation path exists
- no unified recall materialization surface is introduced
- no `runtime.task_spine.*`, `runtime.evidence.*`, or equivalent runtime object
  namespace is introduced for the five labels
- no new durable object family or second inspect truth surface is introduced for
  the five labels
- no required linear `Task -> Skill -> Search -> Evidence -> Finish` workflow is
  introduced
- context provider descriptor invariants remain saturated unless a separate RFC
  justifies a removal-backed change

## Surface Budget

Implemented delta as of `2026-04-22`:

- required authored fields: `0 -> 0`
- optional authored fields: `0 -> 0`
- public tools: `0 -> 0`
- runtime object namespaces for the five labels: `0 -> 0`
- durable object families for the five labels: `0 -> 0`
- second inspect truth surfaces: `0 -> 0`
- recall broker cache schema: `brewva.recall.broker.v4 -> brewva.recall.broker.v5`
- skill routing event: `skill_recommendation_derived` retired and replaced by
  `skill_diagnosis_derived`
- old hosted skill recommendation block: retired from the default path
- recall source-tier render fields: retired in favor of trust label, evidence
  strength, semantic score, ranking score, and rank reasons
- closure lines in default `workflow_status`: compressed behind `[Finish]`
  while detailed posture remains structured output
- generic turn interpretation block: not introduced
- search-intent presentation surface: not introduced

Proposed implementation gate:

- required authored fields must remain non-positive
- optional authored fields must remain non-positive unless they replace a wider
  authoring convention
- net public tool count must remain non-positive
- net runtime object namespaces for the five labels must remain zero
- net durable object families for the five labels must remain zero
- net second-order inspect truth surfaces for the five labels must remain zero
- new rendered views must replace or hide a larger default-path burden
- routing/control-plane decision points in the default prompt path should be
  compressed into the five labels rather than expanded

Target product vocabulary budget:

- default-path product labels: many adjacent concepts -> `5`
- canonical label names: `Task`, `Skill`, `Search`, `Evidence`, `Finish`
- advanced maintainer vocabulary remains inspectable but should not be required
  for common operation

The promotion gate for this RFC is not the existence of five words in docs. The
promotion gate is a measurable reduction in default-path decisions while keeping
authority and source boundaries inspectable.

## Risks And Mitigations

### Risk: Labels Become A Hidden Planner Or Object Layer

Mitigation:

- keep the labels non-authoritative and presentation-only
- preserve provenance for each interpretation
- require explicit `skill_load`
- keep effects governed by existing tool and kernel boundaries
- test that interpretation blocks do not mutate replay state
- reject `runtime.task_spine.*`, `runtime.evidence.*`, equivalent namespaces,
  new durable object families, and second inspect truth surfaces

### Risk: Search Routing Hides Evidence Quality

Mitigation:

- disclose selected source family
- disclose excluded source families when material
- expose trust labels and scope
- keep underlying tools inspectable
- validate with recall evals and source-family correctness metrics

### Risk: Labels Create False Confidence

Mitigation:

- labels must include provenance and missing-evidence notes
- advisory labels must never be rendered like verified evidence
- contradictory or stale evidence must remain visible

### Risk: The Product Layer Adds More Surface

Mitigation:

- require a subtraction ledger for each implementation step
- keep new surfaces internal or presentation-only until they replace a larger
  visible burden
- apply the research surface-budget promotion gate before stable-doc adoption
- do not promote a new block that leaves the previous default recommendation,
  posture, readiness, or closure burden in the same default path

## Open Questions

1. Should the five labels exist only in hosted prompt/context presentation, or
   should there also be a rendered operator view over existing inspect surfaces?
2. Should search intent routing be exposed as a new operator command, or only
   as a rendered interpretation over existing search tools?
3. What minimum evidence-strength taxonomy is needed to fix recall ranking
   without turning ranking into a broad authority policy language?
4. Which metrics best represent "hit rate" for product semantics: first-correct
   skill, first-correct evidence family, reduced clarification turns, or
   successful closure without rework?

## Current Implementation Closure

The `2026-04-22` implementation closes the bounded phases that could remove
known default-path burden without creating a generic product interpretation
layer:

- recall now ranks by source priority, evidence strength, semantic score,
  freshness, curation, and typed intent; that intent is now wired through both
  `recall_search` and the recall context provider
- recall strong evidence now covers kernel truth, tool receipts, skill
  completion, verification outcome, decision receipts, approval lifecycle,
  reversible mutation, rollback, patch, and recovery-WAL append receipts rather
  than a narrow event allowlist
- skill routing now emits diagnosis semantics with selected candidate, rejected
  candidates, readiness, missing inputs, shallow-output risk, and shortest next
  action
- skill diagnosis now selects the actionable candidate inside the semantic
  shortlist, so a nearby `ready` candidate can outrank a blocked semantic leader
- hosted default skill diagnosis is compressed to selected skill, readiness,
  missing inputs, and shortest next action, while the full diagnosis remains
  available through structured payloads
- current-session evidence intent only boosts tape evidence whose session id
  matches the active session
- blocked skill readiness no longer points the model directly at immediate
  `skill_load` as the shortest action
- finish is rendered as one closure view without becoming workflow authority
- stable docs and quality tests reject the retired recommendation block, event,
  recall tier fields, and forbidden runtime namespaces

The remaining product gaps are intentionally not implemented in this closure:

- no bounded turn interpretation block until a subtraction ledger proves which
  default-path blocks it retires
- no intent-routed search presentation until there is evidence that the current
  diagnosis and finish surfaces have actually removed their old burdens
- no full five-label default hosted shell until product-hit-rate metrics justify
  the additional rendered surface

## Promotion Criteria

This RFC can be promoted when:

1. recall evidence-strength ranking passes the recall eval corpus, including
   `recall-precedent-outranks-advisory`
2. hosted default-path context presents task, skill, search, evidence, and
   finish as presentation labels, not runtime objects or ordered stages
3. skill recommendation diagnostics show selected and rejected candidates plus
   missing-input rationale
4. each new product block includes a subtraction ledger that retires, hides, or
   downgrades at least one existing default-path burden
5. search routing preserves source family, scope, freshness, and trust labels
6. closure presentation separates completion, verification, acceptance, and
   delivery posture while presenting one product decision
7. stable docs absorb the accepted contract
8. no `runtime.task_spine.*`, `runtime.evidence.*`, equivalent runtime object
   namespace, new durable object family, second inspect truth surface, or
   required linear workflow has been introduced
9. the final surface budget is non-positive for required fields, public tools,
   and default-path routing decision points, or an explicit exception is
   accepted by runtime/gateway maintainers
