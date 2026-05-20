# Skill And Memory Event Families

This page covers skill catalog refresh and advisory selection events plus
recall, workbench, semantic extraction, and iteration-fact events.

## Skill Catalog

Skills are catalog documents. Runtime events may record catalog refresh,
inventory maintenance, and advisory prompt-context selection, but there is no
activation, completion, repair, or active-skill lifecycle state.

`skill_selection_recorded` records the prompt-visible SkillCard catalog size,
explicit `$skill` mentions, and rendered context size. The hosted turn also
carries a hidden, context-excluded `brewva-skill-selection` custom message with
the explicit mention names and selection id for active-turn traceability. Both
are evidence for model attention, not authority receipts.

## Skill Budget

Per-skill token and tool-call budgets have been removed. Cost, parallelism,
and tool admission are owned by session-level budget and effect governance.

## Recall And Workbench Memory

Recall and workbench events expose semantic memory as inspectable evidence:

- recall curation records operator or runtime curation actions
- recall utility observations describe usefulness signals
- recall surfaced events connect query intent to returned evidence
- workbench events track model-authored notes, reversible evictions, and
  committed baselines

Workbench memory is advisory unless a downstream runtime surface explicitly
uses it as evidence. It is not kernel truth.

## Deliberation And Semantic Extraction

Deliberation and semantic extraction events explain why a summarization,
rerank, or extraction path ran. They are inspection support, not hidden planner
state.

## Iteration Facts

Iteration metric and guard events persist bounded optimization evidence. They
are lineage-aware facts for repeated improvement loops, not a replacement for
task/claim state or verification reports.

## Implementation Anchors

- `packages/brewva-runtime/src/runtime/model/model.ts`
- `packages/brewva-runtime/src/runtime/tape/memory-tape.ts`
- `packages/brewva-recall/src/broker/broker.ts`
