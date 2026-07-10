# Decision: Recall Warms Its Cache After Turn End — Latency Only, Never Delivery

## Metadata

- Decision: After each `turn.ended` advisory ops event the recall broker fire-and-forgets `warm()` — the same dirty-gated, single-flight `sync()` a live search would run — so the next explicit `recall_search` finds a warm broker and read model; warming is strictly index-local performance-only state below the visibility line: no provider or network call, no model-visible byte, no change to what any search returns, and the injection half of the peer prefetch pattern stays rejected.
- Date: `2026-07-10`
- Status: accepted
- Stable docs:
  - `docs/reference/runtime.md`
  - `docs/journeys/operator/recall-and-knowledge-compounding.md`
- Code anchors:
  - `packages/brewva-recall/src/broker/broker.ts`
  - `packages/brewva-recall/src/broker/runtime-port.ts`
  - `test/unit/recall/recall-broker.unit.test.ts`

## Decision Summary

- The mechanism is reuse, not new machinery: `warm()` runs the same `sync()` a search would, guarded single-flight so a background warm and a concurrent live search join one in-flight build, and revision-checked so a warm in flight when an invalidating event lands can never publish soon-stale state. A quiet turn folds to a dirty-gated no-op; a failed warm is a benign no-op the next search rebuilds from.
- The trigger rides existing fan-out: the broker subscribes to the `turn.ended` advisory ops event the hosted gateway already publishes and fire-and-forgets `warm()` — no gateway change, no new dependency, never mid-turn.
- Measured on two real fixtures (2026-07-10, 5 queries × 5 reps per arm, index pre-built for both arms): an 8-session corpus went from cold-search p50 88.5 ms to warm-search p50 0.63 ms (~140× — the full sync cost moved off the critical path); a 6-session corpus whose tapes carry large tool results showed the same absolute win (~43 ms sync off-path) dwarfed by per-query evidence projection (~1 s), so the relative gain there is ~4%.
- The rejected half stays rejected: no speculative pre-selection, no injection of warmed results, no model-visible surface. Warming changes when work happens, never what the model sees or receives.

## Residue

- Large-tape search latency (~1 s per query on tool-result-heavy tapes) is a warming-orthogonal scaling cost in the session-index read path; it was observed during the gate measurement and belongs to the session-index engine, not this mechanism.
- Query-specific warming (seeding toward a likely next query) stays out: it becomes speculative pre-selection, the exact injection half this decision rejects.

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 1: warming moves latency, never attention — the model's explicit `recall_search` remains the only reveal, with identical results either way.
- Axiom 3: no switch was added; warming is dirty-gated default behavior that folds to a no-op when nothing changed.
- Axiom 6: the warmed state is a rebuildable read model over the tape; losing it costs a rebuild, never truth.
- Axiom 18: broker warmth is descriptive performance state — it grants nothing, routes nothing, and is invisible to every authority path.

## Superseded by

- None.
