# Decision: A User Model As A Tape-Folded Advisory Projection

## Metadata

- Decision: Cross-session user modeling lands as the second proving ring for the unmeasurable-benefit candidate axiom (against a literal Honcho port): a model-authored advisory `user.fact.recorded` event, a deterministic rebuildable user-model projection (latest-wins per `(scope, factKey)` with retained supersession), an explicit-pull retrieval surface reusing the recall idiom (inheriting the cache-warming latency win without the injection), and a per-fact `measured` / `estimated` / `inconclusive` grade. Runtime dialectic inference and per-turn injection are rejected (axioms 1, 2, 4), as is the second-memory-store anti-pattern. The user model is a projection the model authored and the tape preserved — graded, explicit-pull, authority-free.
- Date: `2026-06-28`
- Status: accepted
- Stable docs:
  - `docs/reference/runtime.md`
  - `docs/journeys/operator/recall-and-knowledge-compounding.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/user-model.ts`
  - `packages/brewva-tools/src/families/memory/user-model.ts`
  - `packages/brewva-recall/src/broker/broker.ts`
  - `packages/brewva-session-index/src/api.ts`

## Decision Summary

- Fact ownership is the settled recall-versus-summary shape, not a new category: the model authors a `user.fact.recorded` advisory event (`authority: "advisory"`), the tape owns its persistence, a projection owns its read view. A fresh fact is always authored `estimated`; the grade is domain logic, not provider input.
- The user-model projection (`buildUserModelProjection`) folds those events deterministically — latest-wins per `(scope, factKey)`, each superseded entry id retained for audit — and is rebuildable, never replay truth, exactly like the session index. Session-index schema v9 indexes the event so the projection can list every fact cross-session.
- Retrieval is explicit-pull through the recall surface: `RecallBroker.userModel()` and the `user_model` tool are the only reveal. Opening it triggers no recall, no materialization, no provider call, and adds zero prompt bytes; it inherits the next-turn cache-warming latency win without inheriting any injection (axiom 1).
- The per-fact grade is the candidate axiom's account/grade/calibrate method on a second distinct ring beyond compaction economics: `measured` when >=2 distinct sessions independently authored the current value, `estimated` for a single session (the honest floor — a fact restated twice in one session stays `estimated`), `inconclusive` when a competing value exists and the current one is uncorroborated. The grade is evidence; it gates nothing — a `measured` fact grants no capability, routes no model, and bypasses no approval (axiom 18).
- Rejected and not built: per-turn injection of the model into context, a second persistent user-modeling store, and runtime-cadence LLM dialectic inference. Inference stays model-native — the model authors a fact when it concludes one.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- Obeys `Attention belongs to the model` (axiom 1): the model is surfaced on explicit pull, never auto-injected, and the runtime never spends model thought to infer the user (also `Adaptive logic stays out of the kernel`, axiom 2, and `Govern effects, not thought paths`, axiom 4 — the rejected dialectic engine).
- Obeys `Tape is commitment memory` (axiom 6) and `Same evidence is not shared authority` (axiom 11): a user fact is an advisory tape event folded into a rebuildable projection, not an external store, and advisory evidence is not authority.
- Obeys `Inconclusive is honest governance` (axiom 7) and `Descriptive metadata derives views, never authority` (axiom 18): the per-fact grade is a calibrated honesty signal that derives the read view and never gates a runtime decision.

## Open follow-ups

- Conflict resolution is only partially settled, so grade semantics are not frozen. The projection grades a contested `(scope, factKey)` `inconclusive` via a coarse `distinctValues >= 2` heuristic, but with no evidence floor and no defined interaction with eviction/decay. Whether that heuristic (versus a corroboration-windowed or floor-gated rule) is the durable conflict policy stays open and may revise the `measured`/`estimated`/`inconclusive` boundaries.
- Fact scoping is partial: `USER_FACT_SCOPES` is `["user", "project"]`, but whether `project` is the right granularity for project-local standing constraints (versus per-workspace) is unresolved.
- Optional external dialectic enrichment (a Honcho-style service that _proposes_ candidate facts the model then chooses to author) is deferred until the native projection proves itself; it stays advisory-in / model-authors-out and grants nothing.
- Eviction/decay of a stale `estimated` fact, and how it interacts with the corroboration rule, is unresolved.
- This decision records the candidate axiom's second proving instance; promoting the axiom itself remains the candidate-axiom note's job, not this decision's.
