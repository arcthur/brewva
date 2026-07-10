# Tool Family: Memory And Recall

Implementation anchors:

- `packages/brewva-recall/src/types.ts`
- `packages/brewva-recall/src/broker/source-mappers.ts`
- `packages/brewva-recall/src/broker/broker.ts`
- `packages/brewva-tools/src/families/memory/recall.ts`
- `packages/brewva-tools/src/families/memory/workbench.ts`
- `packages/brewva-gateway/src/hosted/internal/context/compaction-input-provenance.ts`

Memory and recall tools inspect or curate durable evidence across current
session tape, repository precedent, model-authored workbench notes, and prior
solutions. Brewva does not maintain a hidden global memory store or
`.brewva/memory/**` hierarchy.

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
  from event tape into typed SQLite + FTS5 query rows.
- `@brewva/brewva-recall` owns product semantics: source families, ranking,
  trust labels, evidence strength, curation, stable IDs, and context rendering.

Recall consumes session-index evidence rows instead of reconstructing event
search text. The SQLite + FTS5 index remains rebuildable helper state; event
tape remains runtime replay authority.

## Surfaces

- recall search and recall curation
- attention option cards, content consumption, workbench pins, session-scoped
  ignores, and verification recipes
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

Recall source families are fixed to `tape_evidence` and
`repository_precedent`. Session/root visibility is orthogonal metadata:
surfaced results carry `sourceFamily`, `sessionScope`, `rootRef`, and
`stableId`. Current-session tape evidence is `current_session`, other tape
evidence is `prior_session`, and repository precedent is `cross_workspace`.
`docs/solutions/**` is cold repository memory; workbench entries are warm
model-authored memory.

Inspecting recall results does not admit them to model-visible context. A
result enters the answer path only when the model explicitly consumes,
injects, cites, or preserves it in workbench state.

Attention options are the bounded product layer over unbounded memory sources:

- `attention_options` returns candidate cards only, excluding options ignored
  earlier in the session
- `attention_consume` returns the selected option's content and records
  consumed refs; `precedent:` ids resolve to the knowledge document body, and
  ids it cannot materialize (for example `tape:` recall hits) refuse with a
  typed `content_unavailable` error naming the `recall_search` stable-id path
  instead of returning identifiers as content
- `attention_pin` resolves the option content first and stores it with the
  pin on the existing workbench pin path
- `attention_ignore` suppresses the option for the rest of the session: it
  disappears from subsequent `attention_options` results (advisory view
  shaping, never authority)

For `session_tape_evidence`, consume returns a redacted event summary rather
than the raw event payload. It preserves event identity and safe structural
fields without exposing command, content, credential, or result payloads.

Option ids are session-local unless the source already has a stable root ref,
such as a recall hit or repository precedent.

Session-index query APIs accept raw query text and apply shared query
tokenization internally. Indexed session and event materialization uses shared
content tokenization so query-side and index-side token policy cannot drift.

## Failure Semantics

Recall misses are not runtime failures. They should be explicit no-signal
outcomes, not fabricated evidence or hidden fallback state.
