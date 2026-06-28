# Decision: Checked Invariants And Disciplined Peer Borrowing

## Metadata

- Decision: Brewva's most load-bearing runtime invariants are upgraded from prose promises into checked artifacts, and two peer mechanisms are borrowed into the ring that already owns the decision under the rule that you borrow a mechanism, never an authority shape.
- Date: `2026-06-28`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/journeys/internal/hosted-behavior-installation.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/host-plugin-capabilities.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/hooks/turn-lifecycle-port.ts`
  - `packages/brewva-substrate/src/host-api/plugin.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-tool-executor.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn/runtime-provider-context.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/prompt-stability.ts`
  - `script/generate-host-plugin-capability-matrix.ts`
  - `test/fitness/host-plugin-capability-invariants.fitness.test.ts`
  - `test/fitness/hosted-materialize-boundary.fitness.test.ts`

## Decision Summary

- The hosted turn-lifecycle-port order is fixed by `HOSTED_LIFECYCLE_PHASES` — coarse, ordered buckets (`pre_model` / `model_io` / `post_tool` / `teardown`) the array is assembled from — and a fitness asserts both the bucket order and that every port declares a bucket. Buckets pin order without ossifying the spine and correctly let one module span non-adjacent phases.
- A generated `capability x plugin` matrix (`host-plugin-capabilities.md`) is produced from the single `RUNTIME_PLUGIN_CAPABILITY_EFFECTS` and `HOSTED_BEHAVIOR_CAPABILITIES` sources and pinned by a regenerate-and-diff fitness, mirroring `axiom-enforcement.md`.
- The no-context-source invariant is guarded positively, never by name denylist: the capabilities whose effect class is context-write must equal exactly `{context_messages.write}`. A `*source*` / `register*` substring ban is itself the checked-nothing this decision rejects.
- A drift guard asserts that `hosted_behavior`'s declared capability set equals the set the journey doc documents, read from one source. It guards doc-versus-code drift, not minimality.
- The hosted lane assembles its provider call on a path parallel to `materialize()`, so `runtime.md` declares the replay-contract boundary: committed tape events replay exactly, while the baseline projection and the environment-derived system prompt are re-rendered, never replayed. A boundary fitness forbids folding the system prompt into the pure projection.
- An in-flight tool-identity guard binds each canonical `tool.proposed` to the advertised tool's identity hash; the executor fails closed on identity drift or on a tool never advertised in that request, while the `HarnessManifest` stays advisory audit correlation.
- The empty `assertHostedBehaviorHostAdapterRuntimeShape` placeholder is deleted, because an empty validator reads as a guarantee that does not exist.
- Borrowing is resolved: `opencode`'s `baseline/update/removed` block algebra lands internally as `diffKeyedBlocks` over dynamic-tail materialization blocks (never its context-source registry), and `pi-mono`'s `renderCall` / `renderResult` ergonomics were already present on `BrewvaToolDefinition`, so that borrow is dropped as redundant.

## Axioms

These obey `docs/architecture/design-axioms.md` and introduce one new axiom:

- Introduces `A documented invariant that nothing checks is a promise, not a contract` (axiom 19): the load-bearing invariants above gain fitness or regenerate-and-diff backing instead of surviving only on a correct human read.
- Obeys `Every commitment has a receipt` (axiom 5): the replay-contract boundary and the tool-identity binding are made explicit receipts, not inferred from code position.
- Obeys `Kernel contracts admit only correctness-bearing judgments` (axiom 16): tool-surface identity drift is a replay-and-approval correctness fault, so its guard belongs at the gate and fails closed.

## Open follow-ups

- The `diffKeyedBlocks` algebra is applied to dynamic-tail blocks only; extending it to the system-prompt prefix waits until `getBaseSystemPrompt` exposes its `BrewvaSystemPromptDocument` rather than a rendered string.
- Whether the hosted lane should eventually converge on `materialize()` (the AGENTS.md target), and whether the matrix should cover the advisory extension ring's ambient capability class, stay tracked.
