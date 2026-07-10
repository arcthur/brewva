# Decision: Model-Facing Runtime Intelligence Rides One Legible RuntimeBrief

## Metadata

- Decision: Runtime intelligence the operator plane already computes (context pressure, last-turn consequences, unexpected cache breaks) reaches the model through exactly one turn-tail `[RuntimeBrief]` block governed by a legibility contract — stable tagged structure, salience order, explicit units, no model-unusable hashes or ids, a demote-then-drop character budget, silence when nothing is decision-relevant — and the brief is strictly inform-only: it derives from receipts and cheap per-turn runtime state, moves no `stablePrefixHash`, and widens no admission, routing, or authority.
- Date: `2026-07-10`
- Status: accepted
- Stable docs:
  - `docs/reference/hosted-dynamic-context.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/context/runtime-brief.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/cache/break-detector.ts`
  - `test/unit/gateway/runtime-brief.unit.test.ts`
  - `test/unit/gateway/hosted-workbench-context.unit.test.ts`

## Decision Summary

- One brief, not many blocks: `[RuntimeBrief]` replaced the `[Context Status]` ledger dump, the bare consequence-digest block, and the standalone compaction gate/advisory blocks plus their `nudgeTracker` cadence machinery. The consequence digest composes in as the `effects (last turn)` section; the compaction ask rides the context-pressure posture line persistently under sustained pressure, demoting to a state-only stub only when the brief's own budget is crowded.
- The legibility contract is the product: sections are relevance-gated (pressure only under advised/forced/predicted states, cache-break only after an unexpected break on the previous turn), salience-ordered, budget-bounded with structure-preserving demotion, and silent when nothing is decision-relevant. A section that cannot render legibly for the model (raw hashes, internal cursors) strips or stays out.
- The cost-observability boundary is honored in form and intent: the brief reads intelligence the runtime already computed for operator surfaces and informs the model; it never admits context, routes providers, gates tools, or seizes the thought path. Rendering it changes no authority state.
- Sections stay gated by the contract's own rules, not by a roadmap: the tool-schema-cost section waits for a model-side lever (`capability_expand`), compaction-economics waits for a cheap per-turn accessor at compaction commit, and verifier findings live on the delegation-outcomes surface so one run never renders twice.

## Residue

- The brief's budget is an internal `RUNTIME_BRIEF_MAX_CHARS` constant; promote it to an `infrastructure.contextBudget.runtimeBriefMaxChars` config key only if a deployment actually needs tuning.
- No per-turn render receipt exists for which sections rendered, demoted, or dropped — deliberate (noisiest possible event, no consumer); the trigger to wire one is the first brief section needing calibration evidence beyond its unit contract, per the advisory-receipt-and-calibration standard.

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 1: the brief informs attention and never seizes it — inform-only by construction, silent when irrelevant.
- Axiom 4: it surfaces consequences and physics, never instructions on how to think.
- Axiom 6: every section derives from committed receipts or cheap per-turn runtime state; nothing is a second store.
- Axiom 7: relevance gating renders absence honestly — no section fabricates certainty to fill space.
- Axiom 18: the brief is a descriptive projection; rendering it grants nothing and gates nothing.

## Superseded by

- None.
