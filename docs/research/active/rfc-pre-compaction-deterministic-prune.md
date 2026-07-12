# RFC: Pre-Compaction Deterministic Prune — Dedupe, Informative Replace, And Image Strip Before LLM Summarization

## Metadata

- Status: active
- Implementation state: Phase 1 + Phase 2 landed — dedupe / informative-replace /
  image-strip in `packages/brewva-substrate/src/compaction/prune.ts`, the
  `session.pre_compact_prune` tape receipt, and the `compaction.pruneEnabled`
  config. Phase 3 (real-session effectiveness measurement + report surfacing) is
  not yet done, so the RFC stays active.
- Owner: Substrate, runtime, and gateway maintainers
- Last reviewed: `2026-07-06`
- Depends on:
  - [Decision: Context Operating System And Compaction Physics](../decisions/context-operating-system-and-compaction-physics.md)
    (compaction pipeline ownership; the insertion point for the prune layer)
  - `docs/journeys/internal/context-and-compaction.md` (compaction flow, gate,
    and resume; the pipeline this RFC extends)
  - `packages/brewva-substrate/src/compaction/session-cut-point.ts` (existing
    token-budget cut point; the prune runs before this step)
  - `packages/brewva-substrate/src/context-budget/api.ts` (`decideCompaction`;
    the pure policy that triggers the prune)
- Also related:
  - [RFC: Quantified Compaction Economics And Graded Evidence Honesty](./rfc-quantified-compaction-economics-and-evidence-honesty.md)
    (the `netReuseValue` verdict this prune improves by reducing LLM
    summarization input)
  - [RFC: Peer-Distilled Context Loops](./rfc-peer-distilled-context-loops.md)
    (`compaction_ineffective` skip posture; the prune is a proactively
    anti-ineffective measure)
- Promotion target:
  - `docs/reference/runtime.md` (compaction contract)
  - `docs/journeys/internal/context-and-compaction.md` (compaction flow)
  - `packages/brewva-substrate/src/compaction/` (pure prune implementation)

## Problem Statement

Brewva's compaction pipeline goes directly from pressure detection to LLM
summarization. When `decideCompaction(...)` returns a compaction decision, the
hosted compaction controller calls `workbench_compact` (or the hosted
auto-compaction path), which invokes the LLM to produce a compaction summary.
The LLM summarizer processes the full context — including redundant,
duplicate, and structurally compressible content that a deterministic pass
could eliminate cheaply.

The existing `selectBrewvaSessionCompactionCutPoint(...)` in
`packages/brewva-substrate/src/compaction/session-cut-point.ts` performs a
token-budget-based tail selection: it walks keepable entries from the end
backward, accumulating tokens until the `tailProtectTokens` budget is
exhausted. This determines **what to keep** but does not **reduce what is
summarized**. The entries before the cut point are sent to the LLM summarizer
in their full form.

Two peer harnesses address this gap with a deterministic pre-compaction pass:

- `hermes-agent` runs a no-LLM prune before LLM summarization: md5-dedupes
  identical tool results (>=200 chars), replaces old tool outputs with
  informative one-liners ("`[terminal] ran npm test -> exit 0, 47 lines`"),
  strips images from old multimodal results, and truncates tool-call args to
  200 head characters. This runs before the head/tail protection and LLM
  summary steps, reducing both the LLM call cost and the summary's noise floor.
- `claude-code` runs a microcompact layer that clears content of old
  compactable tool results (Read, Bash, Grep, Glob, WebSearch, WebFetch, Edit,
  Write) per-turn, before auto-compact triggers. A cached variant uses
  Anthropic's `cache_edits` API to delete tool results without busting the
  cache prefix.

Brewva has transient outbound reduction (per-request copy) and tool-result
distillation (same-turn summary), but neither is a **persistent pre-compaction
prune** that reduces the LLM summarizer's input. The transient reduction
operates on the outbound provider request copy only — it does not mutate
runtime history or compaction inputs. The tool-result distiller operates
same-turn on large pure-text payloads — it does not dedupe across turns or
replace old tool outputs with informative one-liners.

The gap: when the context holds 10 grep outputs from the same session (some
likely identical or near-identical), 5 full file reads (some partially
overlapping), and 3 image-bearing tool results from earlier turns, all of
that content is sent to the LLM summarizer verbatim. A deterministic pass
that dedupes, replaces, and strips before the LLM call would (a) reduce the
LLM summarization token cost, (b) improve summary quality by reducing the
noise floor, and (c) reduce the frequency of compaction-triggered `wasteful`
verdicts by making each compaction more effective.

## Scope Boundaries

In scope:

- a pure, deterministic prune pass that runs after `decideCompaction(...)`
  returns a compaction decision and before the LLM summarization call
- three prune operations: identical-result deduplication (md5 hash,
  > =200 chars), informative one-liner replacement for old tool results, and
  > image stripping from old multimodal results
- a new tape event (`session.pre_compact_prune`) recording what was pruned,
  making the prune replay-visible and inspectable
- integration with the existing compaction pipeline (hosted manual, hosted
  auto, and model-downshift paths)

Out of scope:

- LLM-based summarization or compression (the prune is deterministic; the
  LLM summarizer runs after the prune, unchanged)
- mutating runtime history or replay inputs (the prune operates on the
  compaction input set, not on the tape; the tape remains authoritative)
- changing the compaction gate, threshold, or trigger logic (the prune runs
  only after compaction is already decided)
- per-turn microcompaction (the prune is per-compaction, not per-turn; the
  transient outbound reduction already handles per-turn reduction)
- model-facing prune suggestions (the prune is a runtime physics operation,
  not an attention advisory; the model is not consulted)

Out of scope but tracked:

- argument truncation for old tool-call args (hermes truncates to 200 head
  chars) — useful but changes the replay shape of tool-call messages; deferred
  until the prune's replay semantics are proven stable
- a model-invoked `workbench_prune_suggest` tool that surfaces prune
  candidates to the model as attention options — a future advisory complement

## Why

### Why a deterministic prune before LLM summarization

The LLM summarizer is the most expensive part of the compaction pipeline —
it is a full model call with a large input. Every redundant tool result in
that input is a wasted token. A deterministic pass that eliminates redundancy
before the LLM call reduces both the cost and the noise floor of the summary.

This is runtime physics (context window management), not attention selection.
The prune is deterministic: md5 deduplication, metadata-only one-liner
replacement, image stripping. No salience judgment, no "which result is more
important" ranking. The model owns attention; the runtime owns physics.

**Scope honesty — this is a bounded win.** The prune only shrinks the _LLM
summarizer's_ input; it does not reduce per-turn outbound tokens (the transient
outbound reduction already clears old large tool results per request, and the
summarizer's own token estimate already truncates each tool result to 2000
chars). The marginal saving is real but narrow, and the Phase 3 `<5%` gate is a
genuine kill switch, not a formality. Before building a new persistent prune
_plus_ a new tape event, evaluate the cheaper alternative: add md5-dedupe and
image-strip to the _existing_ transient outbound reduction walker
(`provider-request-reduction-walker.ts`), which is transient and needs no new
receipt. That path captures much of the value for far less machinery; the
persistent, tape-recorded prune earns its extra weight only if the summarizer
input is where the measured waste actually is.

### Why this is not already covered

Brewva has two existing reduction mechanisms, but neither covers this gap:

1. **Transient outbound reduction** (`provider-request-reduction.ts`): clears
   older large text-only tool-result bodies on the outbound provider request
   copy. This is per-request and non-persistent — it does not reduce the
   compaction input. The next request rebuilds from full history.

2. **Tool-result distiller** (same-turn): replaces large pure-text
   `tool_result` payloads with bounded summaries after raw evidence is
   recorded. This is same-turn and per-result — it does not dedupe across
   turns or replace old tool outputs with one-liners.

The prune layer is **per-compaction and persistent**: it runs once when
compaction is triggered, produces a tape event, and reduces the input to the
LLM summarizer. The existing mechanisms are orthogonal and continue to run.

### Why the prune must be tape-recorded

Brewva's constitution says `Tape owns truth`. A prune that silently replaces
tool results without a receipt would be an unrecorded history mutation —
exactly what the tape is supposed to prevent. The prune produces a
`session.pre_compact_prune` tape event recording what was deduped, replaced,
or stripped. Replay shows the original content (from the original
`tool.result.recorded` events) and the prune event (recording the
transformation). The compaction summary event (`session_compact`) references
the prune event in its input provenance.

This is heavier than hermes's approach (hermes directly modifies the messages
array with no receipt) but it is the brewva-native way: every history
transformation is tape-accountable.

## Direction

1. **Pure and deterministic.** The prune is a pure function over the
   compaction input entries. No LLM call, no salience judgment, no adaptive
   logic. Given the same input entries, the prune produces the same output.

2. **Three operations, ordered.** The prune runs three operations in order:
   a. **Dedupe**: md5 hash identical tool-result bodies (>=200 chars); keep
   the most recent occurrence, replace earlier occurrences with a
   one-liner referencing the duplicate.
   b. **Informative replace**: for tool results older than the tail-protection
   window, replace the full body with a one-liner derived from the _typed_
   fields on the compaction message shape — `toolName` plus a computed size.
   Exit code, line count, and match count are **not** typed on the compaction
   entry (they live only in the unstructured result text), so Phase 1 stays
   metadata-only; a richer body-parsing one-liner is tracked in Open Questions,
   not in the deterministic core.
   c. **Image strip**: for multimodal tool results older than the
   tail-protection window, remove image content blocks, keeping text
   blocks and a textual note that images were stripped.

3. **Tape-recorded.** The prune produces a `session.pre_compact_prune` tape
   event with the list of transformations applied (entry id, operation,
   original digest, replacement summary).

4. **Before cut-point selection.** The prune runs before
   `selectBrewvaSessionCompactionCutPoint(...)`, so the cut-point selection
   operates on the pruned input. This means the tail-protection budget
   covers the pruned (smaller) entries, potentially keeping more recent
   context.

## Architectural Positions

- **The prune is runtime physics, not attention selection.** It does not
  decide which results are "important" — it dedupes identical content and
  replaces old content with compact metadata. The model still owns what to
  keep (through workbench notes and attention pins) and what to evict
  (through `workbench_evict`).

- **The prune does not mutate the tape.** The original `tool.result.recorded`
  events on tape are unchanged. The prune operates on the compaction input
  set (the entries being considered for summarization) and produces its own
  tape event recording the transformation. Replay reconstructs the original
  content from the original receipts; the prune event is an additional
  evidence layer.

- **The prune is not a compaction.** It does not produce a compaction
  summary, does not create a new baseline, and does not trigger turn resume.
  It is a pre-step that reduces the LLM summarizer's input. The
  `session_compact` receipt remains the only replay-visible history rewrite
  authority.

- **The prune is idempotent.** Running the prune twice on the same input
  produces the same output (the second run finds nothing to dedupe or
  replace). This is a safety property: if compaction is retried after a
  failed prune, the second prune is a no-op.

## Source Anchors

Stable docs and decisions:
`docs/research/decisions/context-operating-system-and-compaction-physics.md`,
`docs/journeys/internal/context-and-compaction.md`,
`docs/architecture/design-axioms.md` (axioms 1, 6, 8).

Internal implementation anchors:

- `packages/brewva-substrate/src/compaction/session-cut-point.ts` (existing
  cut-point selection; the prune runs before this)
- `packages/brewva-substrate/src/compaction/projection.ts` (existing
  compaction projection; the prune output feeds into this)
- `packages/brewva-substrate/src/compaction/transcript-format.ts` (token
  estimation; the prune uses these utilities for size thresholds)
- `packages/brewva-substrate/src/context-budget/api.ts` (`decideCompaction`;
  the pure policy that triggers the prune)
- `packages/brewva-gateway/src/hosted/internal/session/managed-agent/compaction-lifecycle.ts`
  (`ManagedSessionCompactionLifecycle.preview()` — the actual summarize-and-cut
  sequence; the prune is wired here, shaping ONLY the LLM summarizer input. The
  retained tail is re-derived from session-store entries by the cut point, not
  from the pruned array, so pruning never changes what is kept.
  `hosted-compaction-controller.ts` owns only the commit side, not the prune seam)
- `packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts`
  (transient outbound reduction; the orthogonal per-request mechanism)
- `packages/brewva-gateway/src/hosted/internal/session/tools/tool-result-distiller.ts`
  and `.../session/tools/tool-output-distiller.ts` (the same-turn tool-result
  distiller — registered in `host-api-installation.ts`, not in `session.ts`; the
  orthogonal same-turn mechanism)
- `packages/brewva-vocabulary/src/internal/context.ts` (compaction event
  family; the new `session.pre_compact_prune` event extends this)

External comparison anchors (mechanism only, not their tape-less approach):

- `/Users/bytedance/new_py/hermes-agent/agent/context_compressor.py` (lines
  1179-1300: no-LLM prune pass — md5 dedupe, informative one-liner
  replacement, image stripping, arg truncation)
- `/Users/bytedance/new_py/claude-code/src/services/compact/microCompact.ts`
  (per-turn tool-result clearing before auto-compact)

## Architecture Proposal

### 1. Prune Function (substrate, pure)

A pure function `pruneCompactionInput(...)` in
`packages/brewva-substrate/src/compaction/prune.ts`:

```typescript
interface PruneInput {
  entries: readonly CompactionEntry[];
  tailProtectEntryIds: ReadonlySet<string>; // entries in the tail-protect window
  dedupeMinChars: number; // default 200
  informReplaceOlderThanTail: boolean; // default true
  stripImagesOlderThanTail: boolean; // default true
}

interface PruneOperation {
  entryId: string;
  operation: "dedupe" | "inform_replace" | "image_strip";
  originalDigest: string; // md5 of original body
  replacementSummary: string; // the one-liner or note
}

interface PruneResult {
  prunedEntries: readonly CompactionEntry[]; // entries after pruning
  operations: readonly PruneOperation[]; // what was done
  tokensSaved: number; // estimated token reduction
}

export function pruneCompactionInput(input: PruneInput): PruneResult;
```

### 2. Dedupe Operation

- For each tool-result entry with body length >= `dedupeMinChars`, compute
  md5 hash of the body text.
- Group by hash. For groups with >1 occurrence, keep the most recent entry
  unchanged; replace earlier occurrences with:
  `[deduplicated] identical to entry <id> (most recent occurrence)`

### 3. Informative Replace Operation

- For tool-result entries older than the tail-protection window (i.e., not in
  `tailProtectEntryIds`), replace the full body with a one-liner built from the
  typed fields on the compaction message shape (`toolName` plus a computed
  size):
  - `[tool:<name>] ~<N> tokens elided (see tape event <id>)`
- This is genuinely deterministic and body-free: `toolName` is a typed field on
  the agent-protocol message, and the size comes from the existing token
  estimator — no parsing of the result text.
- **Explicitly not in the deterministic core:** richer, tool-specific
  one-liners (`[grep] pattern -> N matches`, `[exec] -> exit 0, N lines`)
  require reading the unstructured result text, because exit code, line count,
  and match count are _not_ typed fields on the compaction entry (they sit
  inside the tool-result text / `details`). Hermes' `_summarize_tool_result`
  does parse the body to produce these. Brewva can earn the richer form later by
  recording exit code / line count / match count on the `tool.result.recorded`
  receipt at emission time (a per-tool metadata contract), after which the
  replacement stays body-free; until then, the metadata-only form above is the
  honest deterministic version. Tracked in Open Questions.

### 4. Image Strip Operation

- For multimodal tool-result entries older than the tail-protection window,
  remove `image` content blocks, keeping `text` blocks.
- Append a text note: `[<N> images stripped from original result]`

### 5. Tape Event

A new vocabulary event, type string `session.pre_compact_prune`
(`SESSION_PRE_COMPACT_PRUNE_EVENT_TYPE`), payload schema
`brewva.pre-compaction-prune.v1`:

```typescript
{
  schema: "brewva.pre-compaction-prune.v1",
  sessionId: string,
  compactId: string,           // links to the subsequent session.compact
  operations: readonly SessionPruneOperation[],
  tokensSaved: number,
}
```

The tape envelope already carries the event timestamp, so the payload does not
duplicate it. The receipt is emitted as advisory telemetry on the runtime tape
(`runtime.ops.context.telemetry.preCompactPrune`) and is deliberately NOT a
context-source event: it is durable and replay-visible but never materialized
back into the compacted context — the same treatment as `tool.result.recorded`.

### 6. Pipeline Integration

The prune runs inside `ManagedSessionCompactionLifecycle.preview()`, after
`decideCompaction(...)` has decided to compact and the full context is read, and
feeds ONLY the LLM summarizer input. The retained tail is unaffected: the cut
point (`previewCompaction`) re-derives `firstKeptEntryId` from the session-store
entries, not from the pruned message array — so the prune shapes what the
summarizer reads, never what is kept verbatim. `tokensBefore` is likewise
computed from the original (unpruned) messages, so compaction economics report
the true pre-compaction size.

```
decideCompaction() → should compact
  ↓
[NEW] pruneCompactionInput(originalContext.messages)   // summarizer input only
  ↓
LLM summarization (existing, now on pruned input)
  ↓
previewCompaction() (existing, tail re-derived from entries — NOT the pruned array)
  ↓  (on commit, in finalize())
session.pre_compact_prune receipt (NEW — advisory telemetry, joined by compactId)
session.compact receipt (existing)
```

The receipt is emitted at commit time (`finalize()`), so a rolled-back preview
leaves no receipt.

## How To Implement

### Phase 0: Boundary confirmation

- Confirm the compaction input entries are available in a shape the prune
  function can consume (tool name, body text, content blocks, metadata).
- Confirm the tail-protection window is computable before cut-point selection
  (it is — the tail-protection budget is a config input, and the keepable
  entries are known before the cut point is selected).
- Decide whether the prune runs for all three compaction paths (hosted manual,
  hosted auto, model-downshift) or only hosted auto initially.

### Phase 1: Dedupe + informative replace

- Implement `pruneCompactionInput(...)` with dedupe and informative replace.
- Wire into the hosted compaction controller.
- Emit `session.pre_compact_prune` tape event.
- Fitness: the prune is deterministic and idempotent; replay shows the prune
  event; the `session_compact` receipt references the prune receipt; the LLM
  summarizer input is verifiably smaller.

### Phase 2: Image strip

- Add image stripping for multimodal tool results.
- Fitness: image blocks are removed from old entries; text blocks are
  preserved; the strip operation is recorded in the prune event.

### Phase 3: Effectiveness measurement

- Add a `pruneEffectiveness` field to the `session_compact` receipt's cache
  impact: `tokensSavedByPrune` (from the prune result) alongside the
  existing `fromTokens` / `toTokens`.
- The `report:context-evidence` report includes prune effectiveness in its
  compaction summary.
- Gate: if the prune consistently saves <5% of the LLM summarizer input
  across real sessions, reconsider whether the prune complexity is justified.

## Validation Signals

- Determinism fitness: given the same input entries, the prune produces the
  same output (property test).
- Idempotency fitness: running the prune twice on the same input produces the
  same output (property test).
- Replay fitness: the `session.pre_compact_prune` event is replay-visible;
  replay shows both the original `tool.result.recorded` events and the prune
  transformation; the `session_compact` receipt references the prune receipt.
- Authority fitness: the prune does not mutate tape events; it operates on
  the compaction input set only; the tape remains authoritative.
- Economy fitness: the LLM summarizer input is verifiably smaller after the
  prune (measured in tokens, not just entries).
- `bun run check` and the full `bun test` suite both green.

Landed: the determinism / idempotency / purity / protected-safe / accounting
property tests plus the per-operation and receipt-reader unit tests live in
`test/unit/substrate/compaction-prune.unit.test.ts`. Real-session economy
measurement (Phase 3) is still pending.

Phase 3 channel finding (2026-07-10): headless cannot produce the
effectiveness signal. With the `before_provider_request` pressure re-check
landed, auto compaction now genuinely fires headlessly under
`BREWVA_EVAL_FORCE_COMPACTION` — a three-turn `--print --session` GLM5.2
session (`d5f1a464`, 20k eval window) fired it three times — but every cut was
`minimum_tail` over 103/212/317 tokens with zero `session.pre_compact_prune`
receipts, because a headless resume does not re-materialize prior turns'
transcript into context: the compactable region only ever holds bootstrap
entries plus the previous summary, never old tool results, so the prune's
eligible set stays empty by construction. The >=5% effectiveness signal
therefore must come from interactive-session telemetry, where transcript
genuinely accumulates, not from headless validation runs.

## Surface Budget

| Surface                               | Before | After | Notes                                                                        |
| ------------------------------------- | -----: | ----: | ---------------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | No new configuration; prune thresholds are internal constants.               |
| Optional authored fields              |      0 |    +1 | `compaction.pruneEnabled` config (default true), held minimal.               |
| Author-facing concepts                |      0 |     0 | The prune is runtime physics, not an author-facing concept.                  |
| Persisted formats                     |      0 |    +1 | `session.pre_compact_prune` event (schema `brewva.pre-compaction-prune.v1`). |
| Inspect surfaces                      |      0 |     0 | Prune operations are visible through existing tape inspection.               |
| Public tools                          |      0 |     0 | The prune is not model-invoked.                                              |
| Routing/control-plane decision points |      0 |    +1 | The prune runs inside the compaction pipeline; no new external decision.     |

## Promotion Criteria

Move to `docs/research/decisions/` only after:

- [x] Phase 1 (+ Phase 2) implemented and green: dedupe / informative-replace /
      image-strip with the `session.pre_compact_prune` tape receipt. Landed and
      covered by unit + property tests; `bun run check` and full `bun test` green.
- [ ] A measurable effectiveness signal: the prune consistently saves >=5% of
      the LLM summarizer input tokens across real sessions. Needs production
      telemetry (Phase 3) — cannot be satisfied by code alone.
- [ ] The `session.compact` receipt references the prune receipt in its input
      provenance. Today the join is one-way: the prune receipt carries the shared
      `compactId`; the reverse reference on `session.compact` is Phase 3.
- [ ] Stable docs (`docs/reference/runtime.md` compaction contract and the
      `context-and-compaction.md` flow prose) carry the prune. Deferred to promotion.

Status: 1 of 4 met — NOT promotable yet. The RFC stays active until the Phase 3
effectiveness signal is measured and the provenance back-reference plus the
stable-doc contract land.

## Open Questions

- Should the informative one-liner extraction be tool-specific (grep shows
  pattern + match count, read shows path + line count) or generic (first
  non-empty line for all tools)? Tool-specific is more useful but requires
  per-tool metadata in the result receipt. Current impl is generic
  (`[tool:name] ~N tokens elided`); whether tool-specific pays off is still open.
- How should the prune interact with pinned workbench entries (`attention_pin`
  retention contract)? Pinned entries should be excluded from the prune. The
  current `protectedTools` set only exempts curated-memory tools by name, not
  `attention_pin`'d results — still open.

Resolved during implementation:

- The prune runs for every compaction path (hosted manual, auto, and model
  downshift): they all funnel through `ManagedSessionCompactionLifecycle.preview()`,
  so no path-specific timing issue surfaced.
- A per-call `skipPrune` is unnecessary: `compaction.pruneEnabled` (default
  `true`) is the global kill-switch, and the prune is advisory — it never mutates
  the tape or the retained tail.

## Related Docs

- `docs/journeys/internal/context-and-compaction.md`
- `docs/reference/runtime.md`
- `docs/research/active/rfc-quantified-compaction-economics-and-evidence-honesty.md`
- `docs/research/active/rfc-peer-distilled-context-loops.md`
- `docs/architecture/design-axioms.md`
