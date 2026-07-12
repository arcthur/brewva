# Skill And Memory Event Families

This page covers skill catalog refresh and advisory selection events plus
recall, attention options, workbench, semantic extraction, and iteration-fact
events.

## Skill Catalog

Skills are catalog documents. Runtime events may record catalog refresh,
inventory maintenance, and advisory prompt-context selection, but there is no
activation, completion, repair, or active-skill lifecycle state.

`skill.selection.recorded` records prompt-visible SkillCard shortlists and
`discover_skills` discover-only projections: available count, candidate count,
rendered count, omitted count, selection mode, explicit `$skill` mentions,
rendered reasons, advisory `skillInvocationRecords`, and rendered context size.
The hosted turn also carries a hidden, context-excluded
`brewva-skill-selection` custom message with the explicit mention names,
selection id, counts, and selection mode for active-turn traceability. Both are
evidence for model attention, not authority receipts.

## Skill Budget

There are no per-skill token or tool-call budgets. Cost, parallelism, and tool
admission are owned by session-level budget and effect governance.

## Recall And Workbench Memory

Recall, attention option, and workbench events expose semantic memory as
inspectable evidence:

- recall curation records operator or runtime curation actions
- recall utility observations describe usefulness signals
- recall surfaced events connect query intent to returned evidence through
  projected `sourceFamily`, `sessionScope`, `rootRef`, and `stableId`
- attention option metric observations record bounded option exposure,
  consumption, pin, ignore, and verify-plan refs separately from automatically
  available context
- `attention.option.consumed` records the typed consume receipt for a selected
  attention option, including the option id, source family, consumed refs, and
  optional model-authored reason. Per-entry consume counts are replay-derived
  from these receipts; they are not stored on workbench entries.
- workbench events track model-authored notes, reversible evictions, and
  committed baselines

Workbench memory is advisory unless a downstream runtime surface explicitly
uses it as evidence. It is not kernel truth.

`session.compaction.committed` carries `inputProvenance` for compacted active
sets. The provenance records active workbench entry ids, selected skill
invocation ids, surfaced resource refs, capability receipt refs, bounded used
recall refs, consumed attention refs, pinned attention refs, ignored attention
refs, verify-plan refs, compact baseline metadata, and
`hiddenRecallSearch=false`. The v2 provenance schema also carries structured
file arrays for `readFiles`, `modifiedFiles`, `workbenchReferencedFiles`, and
`recallFilesUsedInSummaryInput`; these arrays come from existing structured
refs rather than shell-text parsing.
Compaction does not run recall search behind the model.

## Deliberation And Semantic Extraction

Deliberation and semantic extraction events explain why a summarization,
rerank, or extraction path ran. They are inspection support, not hidden planner
state.

## Iteration Facts

Iteration metric and guard events persist bounded optimization evidence. They
are lineage-aware facts for repeated improvement loops, not a replacement for
task/claim state or verification reports.

## Implementation Anchors

- `packages/brewva-runtime/src/runtime/model/impl.ts`
- `packages/brewva-runtime/src/runtime/tape/impl.ts`
- `packages/brewva-recall/src/broker/broker.ts`
