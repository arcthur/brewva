# Decision: Authority Rings And Projection Unification

## Metadata

- Decision: rings are the single authority coordinate system beneath the four-owner constitution; planes are read-only projections of rings rather than a parallel taxonomy.
- Date: `2026-06-19`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/design-axioms.md`
- Code anchors:
  - `test/fitness/ownership-grammar.fitness.test.ts`
  - `test/fitness/docs/platform-growth-governance.fitness.test.ts`
  - `test/fitness/docs/reference-glossary-coverage.fitness.test.ts`

## Decision Summary

- The four-owner constitution remains the top-level ownership model.
- Rings refine authority beneath that constitution and remain the only first-class coordinate system at that layer.
- Plane names survive only as read-only projection labels attached to their owning rings; projections never grant authority.
- `system-architecture.md` owns the complete topology, while `design-axioms.md` carries the smaller authority-bearing view.
- The change removes a parallel taxonomy without changing runtime routing, persisted formats, or public APIs.

## Axioms

This decision is judged against `docs/architecture/design-axioms.md`:

- Obeys axiom 11 (Same evidence is not shared authority): projections may share evidence while their owning ring retains authority.
- Obeys axiom 14 (Documentation hierarchy follows authority hierarchy): the authority taxonomy is primary and visibility terminology derives from it.
- Obeys axiom 15 (Public width should compress toward authority width): removing the peer plane taxonomy reduces explanatory surface without widening contracts.

## Superseded by

- None.
