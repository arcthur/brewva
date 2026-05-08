# Tool Family: Memory And Recall

Memory and recall tools inspect or curate durable evidence across current
session tape, repository precedent, model-authored workbench notes, and prior
solutions.

## Boundary

These tools are advisory unless a caller explicitly records their output
through runtime authority. Search results should preserve source family and
provenance so the model can distinguish current-session evidence from
repository precedent.

## Retrieval Spine

Read-path retrieval is split across three package owners:

- `@brewva/brewva-search` owns normalization, mandatory CJK segmentation, and
  query/content token policy.
- `@brewva/brewva-session-index` owns rebuildable indexed evidence projection
  from event tape into typed DuckDB query rows.
- `@brewva/brewva-recall` owns product semantics: source families, ranking,
  trust labels, evidence strength, curation, stable IDs, and context rendering.

Recall consumes session-index evidence rows instead of reconstructing event
search text. DuckDB remains rebuildable helper state; event tape remains
runtime replay authority.

## Surfaces

- recall search and recall curation
- model-authored workbench note, evict, and undo-evict operations
- knowledge capture and knowledge search
- precedent audit and sweep
- solution-record parsing and rendering
- iteration facts

## Retrieval Scope

Repository-scoped retrieval filters repository artifacts to the current task
target roots. Session-local tape search remains scoped to the requested
session. Cross-session recall must surface provenance instead of merging all
evidence into one undifferentiated answer.

Session-index query APIs accept raw query text and apply shared query
tokenization internally. Indexed session and event materialization uses shared
content tokenization so query-side and index-side token policy cannot drift.

## Failure Semantics

Recall misses are not runtime failures. They should be explicit no-signal
outcomes, not fabricated evidence or hidden fallback state.
