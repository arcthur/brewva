# RFC: Recall Next-Turn Cache Warming (Latency, Not Delivery)

## Metadata

- Status: active
- Owner: Recall and substrate maintainers
- Last reviewed: `2026-06-26`
- Depends on:
  - [RFC: Attention As An Accountable Effect](./rfc-attention-as-an-accountable-effect.md)
  - [RFC: Reversible References, Advisory Compression Routing, And Replay-Distilled Precedent](./rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md)
- Promotion target:
  - `docs/reference/runtime.md`
  - `docs/journeys/operator/recall-and-knowledge-compounding.md`

## Problem Statement

`recall_search` is an on-demand tool. The first time the model calls it in a
session — or the first call after invalidating events — the recall broker does a
cold `sync()`: it loads session digests and tape evidence from the rebuildable
SQLite + FTS5 read model and rebuilds its in-memory state
(`RecallBroker.sync()`). That cold path adds latency to the model's explicit
pull, exactly when the model has decided it needs memory and is waiting.

The peer agent (`hermes`) hides this latency by **pre-warming memory in the
background after a turn and injecting the result into the next turn's prompt**
(`MemoryManager.queue_prefetch_all`). The injection half of that design is
**axiom-rejected here**: Brewva forbids opening any read surface that triggers
recall, materialization, provider routing, or background _delivery_ into
model-visible context (the shared projection discipline; axiom 1, `Attention
belongs to the model`). Auto-injecting recall would seize attention.

The residue is the **latency win without the injection**. The framing line:

> Warm the cache, never the context. A faster explicit pull is physics; a
> volunteered memory is attention seizure.

The state-visibility rule in `design-axioms.md` names exactly the lane this lives
in: `Behavior-changing state should be replay-derived. Visibility-changing state
should be projection-visible. Performance-only state may remain local.` Cache
warmth is **performance-only state**: it changes neither what the model sees nor
what `recall_search` returns — only how fast the same explicit pull resolves.

## Scope Boundaries

In scope:

- a background `warm()` that runs the broker's existing `sync()` off the turn's
  critical path, after a turn settles, so the next `recall_search` finds a warm
  broker and a warm SQLite/FTS read model (warming is workspace-level — the
  broker's read model is not per-session, so no `sessionId` is threaded)
- a single-flight + idempotent guard so concurrent warms and a racing live
  `search()` never double-build or corrupt broker state
- strictly local warming: reading the rebuildable session index and folding
  broker state — no provider call, no embedding request, no network

Out of scope (owned elsewhere; this RFC must not re-open):

- any injection of recall results into the system prompt, the user message, or
  any model-visible context → forbidden by the projection discipline and axiom 1;
  the reveal boundary stays the `recall_search` tool, unchanged
- changing _what_ `recall_search` returns (no speculative pre-selection, no
  ranking change) → this RFC only changes latency, never result content
- any provider/embedding call on the warm path → that is "provider routing" the
  projection discipline forbids off an explicit pull, and it would also spend
  cost/budget invisibly; warming is index-local only
- prefetch driven by a _prediction of the next query_ → v1 warms the broker/index
  generally (cold→warm), it does not speculatively run a specific query the model
  has not asked (Open Questions)

## Peer Lens: What `hermes`'s `MemoryManager` Prefetch Gets Right

Verdict vocabulary: **COVERED**, **REJECT**, **BORROW**, **OUT OF SCOPE**.

| `hermes` mechanism                                               | Verdict       | Rationale / where it lands                                                                                                                      |
| ---------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue_prefetch_all(query)` runs recall in a background thread   | BORROW        | The latency idea. In Brewva it warms the broker's `sync()` and the local index, off the critical path — a fiber, not a thread.                  |
| result cached and **injected into the next turn's user message** | REJECT        | Auto-volunteered memory seizes attention (axiom 1). Brewva warms the cache; the model still pulls explicitly via `recall_search`.               |
| prefetch keyed by the last user/assistant message                | OUT OF SCOPE  | Predicting the _specific_ next query is a separate, riskier step (it can warm the wrong thing). v1 warms generally; query-specific is deferred. |
| prefetch issues the same retrieval pipeline (incl. any embedder) | REJECT (here) | A provider/embedding call off-path is forbidden by the projection discipline and spends budget invisibly. Brewva's warm path is index-local.    |
| one-provider-at-a-time prefetch registry to bound cost           | COVERED       | Brewva's broker is already a per-runtime `WeakMap` singleton with a dirty-flag; warming reuses that instance, no new registry.                  |

The honest residue: a **local, off-path `warm()`** that reuses the broker's
existing dirty-flag `sync()` so the next explicit pull is warm. Nothing crosses
into delivery.

## Decision Options

### A. Warm trigger and home (chosen; revised to the real architecture)

`warm()` lives on `RecallBroker` in `@brewva/brewva-recall`, and the broker
triggers it itself. The broker already subscribes to the runtime event stream
(for its dirty flag); the hosted gateway publishes a `turn.ended` advisory ops
event at each turn boundary, and the broker self-warms on it, fire-and-forget.
That is the off-critical-path, after-a-turn-settles trigger this RFC intends —
never on projection open, never on prompt build, never mid-turn.

The subscription is the load-bearing seam, so the broker must exist before the
first pull: `createRecallSearchTool` creates it eagerly at tool-construction time,
not lazily on the first `recall_search`. A lazily-created broker would miss every
turn boundary before the first pull, leaving the session's first recall cold — the
exact latency this RFC targets.

Not the gateway turn envelope (the original sketch): the gateway does not depend
on `@brewva/brewva-recall`, the broker is keyed by tool-runtime source identity
(a gateway-side runtime resolves a _different_ broker), and a `runtime.ops`
coupling into recall is fitness-forbidden. Self-warming on an event the broker
already receives sidesteps all three with zero new dependency.

### B. Concurrency discipline (chosen: single-flight over the existing dirty flag)

The broker already gates rebuilds on a `dirty` flag and session-digest
comparison (`broker.ts`), and is cached per runtime identity in a `WeakMap`. Add
a single-flight promise so a background `warm()` and a concurrent live `search()`
share one in-flight `sync()` rather than racing two builds. `search()` semantics
are unchanged: if it arrives while a warm is in flight, it awaits the same sync;
if the broker is already warm, it returns immediately. The warm path can never
make a `search()` return stale or partial state.

### C. Effect shape (chosen: a fire-and-forget promise; revised)

The original sketch named a `BrewvaFiber` from `@brewva/brewva-effect/primitives`;
no such primitive exists, and the broker's event subscription is a plain callback,
not an Effect context. The warm is a fire-and-forget `void this.warm().catch(() =>
{})` in that callback. It returns `void`; its only effect is broker/read-model
warmth. A failed warm is a benign no-op (the next explicit search rebuilds cold),
so the rejection is swallowed. No session-scoped cancellation: a warm is a short
local read-model fold, not a long-lived fiber.

## Landing Plan

Two phases:

1. **`warm()` + single-flight, no trigger wiring.** Add `RecallBroker.warm()` and
   the single-flight guard; unit-test that a warm followed by a search does one
   build, that a concurrent warm+search shares one in-flight sync, and that warm
   never changes `search()` output on a fixed index. No production trigger yet.
2. **Turn-boundary trigger (broker self-warm).** The broker subscribes to the
   `turn.ended` advisory ops event the hosted gateway already publishes and
   fire-and-forgets `warm()` on it — no gateway change, no new dependency.
   Unit-test that `turn.ended` warms the broker, that no other event does (never
   mid-turn), and that a quiet turn folds to a dirty-gated no-op. Before
   promotion: measure cold-vs-warm `recall_search` latency on a real fixture
   session, and confirm zero model-visible change (no new prompt bytes, identical
   tool output).

## Source Anchors

- Broker rebuild and dirty-flag sync (the path `warm()` reuses): `RecallBroker.sync()`,
  the invalidating-event subscription, and the per-runtime `WeakMap` cache in
  `packages/brewva-recall/src/broker/broker.ts`
- Broker port: `RecallBrokerRuntime` in `packages/brewva-recall/src/broker/runtime-port.ts`
- On-demand search tool (the unchanged reveal boundary):
  `packages/brewva-tools/src/families/memory/recall.ts`
- Rebuildable read model being warmed: `@brewva/brewva-session-index`
  (`querySessionDigests`, `queryTapeEvidence`)
- Turn-boundary signal the broker self-warms on: the `turn.ended` advisory ops
  event the hosted gateway publishes from its turn-end lifecycle hook
  (`packages/brewva-gateway/src/hosted/internal/context/evidence/event-stream.ts`,
  the `turn_end` extension), delivered on the same publishEvent fan-out that
  already carries `recall.curation.recorded` to the broker
- Broker subscription where the warm is wired:
  `packages/brewva-recall/src/broker/broker.ts` (the constructor's records
  subscription, beside the dirty-flag logic)
- Broker created eagerly so it subscribes before the first pull:
  `packages/brewva-tools/src/families/memory/recall.ts` (`createRecallSearchTool`
  creates the broker at tool-construction time, not lazily on first execute)
- State-visibility rule licensing local-only warmth:
  `docs/architecture/design-axioms.md` (`Performance-only state may remain local`)
- Peer precedent (read-only, external repo): `hermes`'s
  `agent/memory_manager.py` (`queue_prefetch_all`, background prewarm)

## Validation Signals

- A `warm()` followed by `recall_search` performs exactly one broker build; the
  second of two back-to-back searches reuses warm state.
- On a fixed session index, `recall_search` output is byte-identical with and
  without a preceding `warm()` — warming changes latency only, never content.
- A concurrent `warm()` and `search()` share one in-flight `sync()` (single-flight
  proven). No fiber-cancellation signal — a warm is a short local fold, not a
  long-lived fiber.
- No provider request, embedding call, or network I/O is issued on the warm path
  (asserted by a no-network test double on the broker runtime).

## Surface Budget

Counts are for the recall surface only; before → after.

- Required authored (model-facing) fields: 0 → 0.
- Optional authored fields: 0 → 0. Warming is invisible to the model.
- Author-facing concepts: +0. No new model-facing or operator-facing concept.
- Inspect surfaces: +0 (a warm leaves no receipt; it is performance-only state,
  not behavior- or visibility-changing state).
- Routing / control-plane decision points: +0. Warming gates nothing; it never
  decides whether an effect commits or what the model sees.
- Config keys: +0 in v1 (an enable flag is conditional; warming is safe-by-default
  because it is local and result-neutral).
- Public CLI surfaces: +0.
- Persisted formats: +0. The warmed read model is already rebuildable from tape.
- net required authored fields: 0. debt owner: recall maintainers.
  re-evaluation trigger: any proposal to warm a _specific predicted query_ or to
  issue a provider/embedding call on the warm path (both would re-open the
  attention/cost boundary and need a fresh review).

The entire RFC lands below the visibility line: zero model-facing bytes, zero
receipts, zero gates. That is the proof it does not touch attention — it only
makes an explicit pull the model already chose resolve faster.

## Promotion Criteria And Destination Docs

Promote only when validation passes against a green `bun run check` and the full
suite, including the byte-identical-output and no-network assertions.

- `RecallBroker.warm()` contract and the performance-only-state framing →
  `docs/reference/runtime.md`.
- The post-settlement warm trigger and its latency rationale →
  `docs/journeys/operator/recall-and-knowledge-compounding.md`.

On acceptance, convert this note to a single-decision record under
`docs/research/decisions/` citing axiom 1 and the state-visibility rule.

## Open Questions

- Query-specific warm: is there a safe, axiom-clean way to warm toward a _likely_
  next query (e.g. seeding the FTS query cache with terms from the just-finished
  turn) without it becoming speculative pre-selection? Deferred until the general
  warm proves its latency win.
- Trigger cadence: warm after every turn, or only after turns that touched recall
  or grew the index past a threshold? Over-warming a rarely-recalled session wastes
  local CPU for no pull.
- Invalidation interaction: confirm a warm in flight when an invalidating event
  lands re-marks dirty and re-warms, rather than caching a soon-stale state.

## Related Work

- The injection half this RFC deliberately drops: the attention RFC's explicit-pull
  discipline and the shared projection rule (`no background delivery`).
- Attention sovereignty: axiom 1 (`Attention belongs to the model`).
- The lane this lives in: the `design-axioms.md` state-visibility rule
  (`Performance-only state may remain local`).
