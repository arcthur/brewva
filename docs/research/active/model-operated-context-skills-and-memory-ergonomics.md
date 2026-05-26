# Research: Model-Operated Context, Skills, And Memory Ergonomics

## Document Metadata

- Status: `active`
- Acceptance state: implementation landed; acceptance is blocked on
  representative working-memory evaluation evidence
- Owner: runtime, gateway, recall, tools, and product architecture maintainers
- Last reviewed: `2026-05-26`
- Acceptance blocker:
  `docs/research/active/model-operated-working-memory-evaluation.md` has
  not yet produced the representative promotion report required by its
  promotion criteria.
- Promotion target:
  - `docs/reference/skills.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/events/skills-and-memory.md`

## Problem Statement And Scope Boundaries

Brewva has accepted the model-operated working-memory architecture. The model
owns attention through workbench and on-demand recall, runtime owns physical
status, recall is source-typed, and `docs/solutions/**` is the canonical cold
repository precedent layer.

The remaining gap is product ergonomics. The model and operator need better
visibility into available SkillCards, selected invocation evidence, active
workbench state, surfaced recall results, compact baselines, context pressure,
compaction posture, and prompt-cache posture.

The goal is to improve discovery and inspection without reintroducing runtime
salience selection, hidden recall admission, or a second knowledge hierarchy.

This note covers:

- SkillCard catalog and invocation ergonomics
- context cockpit as a read-only projection
- canonical repository memory through `docs/solutions/**`
- workbench-backed warm memory and recall provenance
- stable rules for compact preservation

This note does not cover:

- Plan Mode or plan approval
- hook lifecycle surfaces
- SkillCards granting tools, accounts, budgets, model routes, or mutation rights
- hidden recall injection before the model asks
- a context-source provider registry
- `.brewva/memory/**`, global Brewva memory, or a second local memory store
- automatic compact-time recall search
- lossy summaries as authoritative state
- replacing event tape with memory files

## Design Thesis

Brewva should make model-operated attention easier to operate, not less
model-operated. The product surface should give the model and operator better
handles: discoverable skills, inspectable workbench, explicit recall, canonical
repository precedents, and visible context pressure. It should not decide what
the model must think about.

The target product line is:

`Model chooses attention. Cockpit projects posture. Recall owns source families. docs/solutions owns cold memory.`

This RFC participates in the shared projection discipline for this active RFC
bundle: projections must be deterministic from receipts, rebuildable, redacted,
explicit-pull, side-effect free, and unable to widen the underlying authority.
This RFC adds the context-specific invariant that cockpit and catalog inspection
must leave the next model attention input unchanged unless the operator or model
performs an explicit model-visible consume action.

## Current Implementation Status

The contract described here has landed in code and stable docs:

- SkillCard invocation evidence is recorded on the existing
  `skill.selection.recorded` event family, including prompt-visible and
  `discover_skills` inspect-only projections.
- SkillCard projection limits and surfaced resource refs are shared by the
  vocabulary package so hosted shortlists and discovery receipts cannot drift.
- `brewva inspect`, shell inspect, and slash `/inspect` expose the context
  cockpit as a read-only operator projection; tests assert that opening it does
  not mutate event history or prompt-stability evidence.
- Recall surfaced events now project `sourceFamily`, `sessionScope`, `rootRef`,
  and `stableId`, with source families limited to `tape_evidence` and
  `repository_precedent`.
- Compaction commits record `inputProvenance` with `hiddenRecallSearch=false`
  and only active workbench entries, selected skill invocation records,
  surfaced resource refs, capability receipts, pinned or latest-used recall
  refs, and compact baseline metadata.
- Provider cache posture is exposed through the package-owned `CachePosture`
  projection in `@brewva/brewva-token-estimation`.

This note should remain in `active/` until the working-memory evaluation note
produces representative long-session evidence or explicitly accepts that
evidence as a follow-up blocker. Stable docs carry the current contract; this
active note remains only for acceptance provenance.

## Decision Options

### Option A: Keep Context And Memory Surfaces Tool-Only

Leave model-operated memory unchanged and add no new product surface beyond
existing tools. This preserves the accepted architecture but leaves skill
discovery, compact continuity, and recall drift hard to inspect. Assessment:
safe but insufficient.

### Option B: Reintroduce Automatic Context Admission

Add automatic per-turn skill, memory, recall, and diagnostic selection. This can
improve first-turn quality, but it contradicts the model-operated reset, harms
prefix-cache stability, and makes stale memory hard to attribute. Assessment:
not recommended.

### Option C: Add Ergonomic Discovery And Inspection Without Admission

Improve catalog, cockpit, and recall UX while keeping the model in charge of
what to read, recall, note, evict, verify, and compact. This preserves Brewva's
architecture and improves operator trust, but requires strict provenance and
no-mutation guarantees. Assessment: recommended.

## Proposed Contract

### 1. SkillCards Stay Advisory

SkillCards continue to obey the advisory invariants accepted by
`capability-selection-and-authority-isolation.md`: they cannot grant external
authority, expose account tools, raise budgets, bypass capability selection,
declare effect approval, or create hidden completion gates.

This RFC only adds ergonomic affordances on top of those invariants:

- catalog listing
- search and discovery
- argument hints
- resource file references
- examples
- suggested output artifacts
- suggested verification posture
- inline or delegated process hints

Model and effort hints from SkillCards are render-only. They may appear in the
cockpit or operator preset suggestions, but they cannot bind provider physics,
model routing, budget, or effort without explicit capability or preset
selection.

### 2. Skill Invocation Records

When a skill is explicitly invoked or selected into prompt-visible context,
Brewva should record an advisory invocation record.

The record should include:

- skill name
- source path or package source
- selection trigger: `explicit_command`, `suggested`, `delegated`, or
  `discover_only`
- invocation mode: `prompt_visible`, `delegated`, or `inspect_only`
- resource refs surfaced to the model
- `estimatedTokens`, using the shared token-estimation package
- selected capability references, if any, as separate receipts
- output artifacts requested by the skill, if any

The record is advisory evidence. It must not be a completion gate, routing
authority, model-selection authority, budget authority, or tool authority gate.

### 3. Context Cockpit

Add an operator-visible context cockpit that renders model-visible posture
without creating model-visible context.

The cockpit is a read-only projection over existing owners:

| Cockpit field                          | Source owner                                                         |
| -------------------------------------- | -------------------------------------------------------------------- |
| active workbench entries and evictions | runtime workbench service and workbench tools                        |
| context pressure                       | existing context-pressure implementation                             |
| compaction gate state                  | existing context-compaction-gate implementation                      |
| compact baseline                       | history-view baseline and summary generator                          |
| prompt-cache posture                   | normalized `CachePosture` owned by `@brewva/brewva-token-estimation` |
| surfaced recall results                | `recall_search` surfaced-result events and recall broker entries     |
| capability details                     | selected capability receipts and tool-surface evidence               |

Cockpit invariants:

- no new context-pressure, compaction-gate, cache, workbench, or baseline state
  source
- no recall search, capability selection, materialization, provider routing, or
  workbench mutation as a side effect of opening the cockpit
- default catalog and cockpit views stay outside model-visible context
- calling the cockpit before a turn must leave the next model attention input
  hash unchanged for the same session evidence
- cache posture consumers should read the same normalized `CachePosture` value
  rather than re-merging token-cache docs, token estimates, and context evidence
  independently

### 4. Repository-Native Memory

This RFC does not add `.brewva/memory/**` or global Brewva memory.

It also does not add a lukewarm memory tier between session workbench and
reviewed repository knowledge. The long-term contract intentionally chooses two
durable choices: keep a note session-local in workbench, or promote it into the
normal solution-record review flow. A draft-only cross-session store would be a
second knowledge hierarchy unless a later RFC proves otherwise.

Durable human-authored repository memory uses the existing
`docs/solutions/**` solution-record flow. That means:

- `docs/solutions/**` remains the canonical cold repository precedent layer
- solution records reuse `parseSolutionDocument`, `normalizeSolutionRecord`,
  `validateSolutionRecord`, `renderSolutionDocument`, and `SOLUTION_STATUSES`
- repository precedent has source family `repository_precedent`
- promotion, stale routing, and supersession use existing solution-record
  status and derivative-link semantics

Warm session memory remains the workbench:

- `workbench_note` pins active objectives, user corrections, and evidence
- `workbench_evict` removes active attention spans
- `workbench_undo_evict` restores reversible evictions before the next baseline

Memory edits to files do not write event tape by themselves. The cockpit does
not watch the filesystem or display "who edited this solution record" events.
Solution-record file edits become visible to model-operated flows through the
next explicit recall or repository inspection call. Recall calls and workbench
operations do record replay-visible tool/runtime evidence.

### 5. Recall Source Families

Recall source-family ownership stays in `@brewva/brewva-recall`, specifically
the broker source mappers and `RECALL_SOURCE_FAMILIES`.

Current source families are:

- `tape_evidence`
- `repository_precedent`

Current/prior session distinctions are scope, intent, and result metadata, not
new source families. Solution records are repository precedent, not a separate
family. External reference pointers belong to capability or source evidence,
not recall source families.

Recall result projections should keep source type, session visibility, and root
visibility orthogonal:

```ts
interface RecallResultProjection {
  family: "tape_evidence" | "repository_precedent";
  sessionScope: "current_session" | "prior_session" | "cross_workspace";
  rootRef: string;
  stableId: string;
}
```

This RFC does not add a new recall source family. If future work adds typed
private memory, it must update the recall source-family constants, mappers,
trust labels, tests, and stable docs in one change.

### 6. Recall, Verification, And Ignore Semantics

Recall remains on-demand. A recall result enters the model-visible answer path
only when:

- the model explicitly calls `recall_search` or inspects stable ids
- the operator explicitly injects or cites a result into a model-visible turn
- a SkillCard resource is explicitly invoked
- the result is already in the active compact input set

Opening a recall result in an inspect or cockpit surface is not context
admission. Inspect-only viewing must leave the next model attention input
unchanged unless the operator performs an explicit model-visible consume,
inject, or cite action.

Compaction must not run a hidden recall search. Compact memory input must be a
subset of the active set defined in Section 8. If compaction needs fresh recall,
the model must make a model-visible `recall_search` call before compaction.

Verification of stale file, symbol, flag, or command claims is model-operated:

- the model verifies by calling ordinary tools such as read, search, or tests
- automatic recall-return verification is not allowed
- verification is preserved by `workbench_note.source_refs` that include both
  the recall stable id and the verifying tool/event ids
- same-session cockpit views may derive "verified by receipt" from those
  source refs

Ignore semantics reuse existing state:

- ignore an active or pinned memory item with `workbench_evict`
- mark a surfaced recall result as stale, wrong-scope, superseded, or misleading
  with `recall_curate`
- no process-local ignore flag is replay authority

### 7. Compact And Baseline Ergonomics

Compaction should be visible as a model-operated and replay-aware action.

The product surface should show:

- why compaction is required or advised
- what workbench entries will remain active
- what evictions are still reversible
- which recall stable ids and workbench entries were compact inputs
- the compact baseline digest, if already recorded
- whether the baseline is replay-authoritative or degraded fallback
- how much context budget was recovered

Replay must use stored sanitized baselines. The cockpit may show baseline
metadata, but it must not regenerate or reinterpret a baseline.

### 8. Skill And Memory Preservation Across Compaction

Compaction should preserve only explicit facts:

- active workbench entries
- selected skill invocation records
- resource refs actually surfaced to the model
- capability selection receipts
- recall results that were pinned or used
- compact baseline metadata

Definitions:

- `preserved` means explicitly pinned by `workbench_note` or retained as an
  active workbench entry.
- `used` means cited by same-session tool-call args, tool results, or
  `workbench_note.source_refs`.
- the compact active set is `preserved` plus a bounded `topK(used)` set ranked
  by recency and evidence strength, where `K` is selected from the available
  token budget

It should not preserve the entire skill catalog, broad memory index, or hidden
recall search result set by default.

### 9. Scope, Expiry, And Cache Posture

Repository precedent visibility follows recall scope:

- `user_repository_root` is the default
- `session_local` is for current-session tape forensics
- `workspace_wide` requires explicit broader scope

Cross-root use must be explicit and follow target-root rules. A solution record
from another root should not silently enter the prompt path.

Deletion and staleness use existing mechanisms:

- workbench entries use evict and undo-evict before baseline
- recall results use curation signals
- solution records use `active`, `stale`, and `superseded`

Skill catalogs and cockpit views are inspect surfaces by default. They must not
inflate the stable prefix or model-visible catalog unless explicitly invoked.

## Source Anchors

- Model-operated reset and validation:
  `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`,
  `docs/research/active/model-operated-working-memory-evaluation.md`
- Skill and capability authority:
  `docs/research/decisions/capability-selection-and-authority-isolation.md`
- Recall source ownership:
  `docs/research/decisions/recall-source-typed-retrieval-spine.md`,
  `packages/brewva-recall/src/types.ts`,
  `packages/brewva-recall/src/broker/source-mappers.ts`
- Repository memory and implementation:
  `docs/research/decisions/repository-native-compound-knowledge-and-review-ensemble.md`,
  `docs/solutions/README.md`,
  `packages/brewva-tools/src/families/memory/solution-record.ts`,
  `packages/brewva-tools/src/families/memory/workbench.ts`,
  `packages/brewva-tools/src/families/memory/recall.ts`

## Implementation Sketch

### Phase 1: Context Cockpit Projection

- Add a read-only cockpit command or inspect projection.
- Render workbench, recall, compaction, baseline, context pressure, and cache
  posture from existing owner sources.
- Implement cockpit and catalog views under the shared inspect host instead of
  as isolated CLI/TUI surfaces.
- Add a regression test that cockpit inspection does not mutate model attention
  input or trigger recall/capability/materialization side effects.

### Phase 2: Skill Invocation Records

- Record advisory skill selection and explicit invocation records.
- Use selection triggers instead of free-form rendered reasons.
- Keep model, effort, capability, and budget hints render-only.

### Phase 3: Repository Memory Ergonomics

- Reuse solution-record schema and parser for durable repository memory.
- Improve cockpit and recall rendering around repository precedent freshness.
- Do not add `.brewva/memory/**`, global memory, or a new recall family.

### Phase 4: Compact UX

- Extend compaction and workbench views with baseline and input provenance.
- Restrict compact memory inputs to the Section 8 active set.
- Validate explicit preservation without catalog or recall-index reinjection.

## Validation Signals

- Given the same session evidence, cockpit rendering produces the same output
  and leaves next model attention input unchanged.
- Repeating a representative task class shows lower repeated skill discovery or
  recall search count than the baseline, measured by surfaced tool calls.
- Recall results use only `tape_evidence` and `repository_precedent` unless a
  separate RFC expands `RECALL_SOURCE_FAMILIES`.
- Compact input provenance contains only Section 8 active-set entries and records
  the selected `topK(used)` bound.
- Stale file, symbol, flag, or command claims are not treated as current unless
  a verifying tool/event id is cited.
- Prompt-cache stability does not regress when cockpit and catalog stay outside
  model-visible context.

## Promotion Criteria

- Reference docs describe SkillCard invocation records as advisory, not
  authority.
- Context cockpit is documented as an inspect surface, not an admission service.
- Memory docs state that durable repository memory uses `docs/solutions/**` and
  current-session memory uses workbench entries.
- Recall docs keep source-family names aligned with `@brewva/brewva-recall`.
- Compaction docs forbid hidden compact-time recall search and explain
  active-set preservation.
- Tests cover:
  - SkillCards cannot expose external authority or bind provider physics
  - cockpit rendering does not mutate model context or trigger recall
  - recall source-family constants match docs
  - stale file or symbol memory requires verification before recommendation
  - compact preservation is based on pinned or used evidence

## Surface Budget

- Required authored fields: 0 -> 0
- Optional authored fields: 0 -> 2
  - skill resource refs
  - skill argument hints
- Author-facing concepts: 0 -> 8
  - context cockpit, SkillCard invocation record, selection trigger,
    repository precedent as cold memory, workbench as warm memory, compact
    active set, explicit preservation, verification source refs
- Inspect surfaces: 0 -> 4
  - context cockpit, skill invocation view, recall provenance view, compact
    baseline view
- Routing/control-plane decision points: 0 -> 2
  - cockpit no-side-effect projection
  - explicit compact active-set preservation
- Event kinds: 0 -> 1 maximum
  - advisory skill invocation record, if existing skill-selection events cannot
    represent it
- Receipt fields: 0 -> 2 maximum
  - compact input provenance, if existing compact receipt metadata cannot
    represent it
  - `recall.rootRef`, if existing target-root metadata cannot represent the
    canonical root used by recall projection
- Projection types: 0 -> 1 maximum
  - package-owned `CachePosture` projection in `@brewva/brewva-token-estimation`
- Budget constants: 0 -> 1 maximum
  - compact `topK(used)` retention cap, derived from token budget

## Followups (Out Of Scope)

A lukewarm cross-session memory tier is intentionally out of scope. A later RFC
may propose draft solution records, durable workbench notes, or another
cross-session note layer only if it proves why the two-layer model
(`workbench` plus `docs/solutions/**`) is insufficient and how replay,
reviewability, recall source families, and garbage collection remain simple.

## Combined Surface Note

Together with the safety and delegation RFCs, the current active product bundle
proposes 26 author-facing concepts, 13 inspect surfaces, up to 2 new event
kinds, and up to 9 receipt or evidence fields. Reviewers should evaluate this
RFC as part of that combined surface area, especially because all four context
views must be hosted under the shared inspect framework.

Debt owner: runtime, gateway, recall, tools, and product architecture
maintainers. Re-evaluate after representative long-session evidence or by
`2026-08-31`; remove any surface that increases prompt churn without improving
continuity or inspectability.
