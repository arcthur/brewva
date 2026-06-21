# Provider Seam Orthogonality And Observability

- Decision: Borrow opencode/pi-mono seam containment — orthogonal transport and quirks-as-data — and amplify brewva's drift-as-evidence and typed-durability assets across the provider seam, with no four-port runtime widening and no second truth store.
- Date: `2026-06-21`
- Status: accepted
- Stable docs: `docs/journeys/internal/provider-turn-streaming-and-fallback.md`, `docs/reference/provider-streaming.md`, `docs/reference/token-cache.md`, `docs/architecture/invariants-and-reliability.md`, `docs/architecture/control-and-data-flow.md`
- Code anchors: `packages/brewva-std/src/honesty.ts`, `packages/brewva-provider-core/src/quirks/index.ts`, `packages/brewva-provider-core/src/providers/openai-codex-responses/sse.ts`, `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`, `packages/brewva-cli/src/operator/inspect/provider-drift.ts`

## Decision Summary

- Transport is orthogonal to protocol: one `runCodexNormalizer` serves both the
  Codex SSE and WebSocket transports, terminal integrity is asserted once, and
  the dead WebSocket beta-header dance was deleted.
- Quirks are data: model-era and vendor wire reality (model synthesis, route
  predicates, the deployment descriptor) is quarantined in
  `provider-core/src/quirks`, so the catalog and capability decision trees read
  cleanly while the per-provider driver slices stay vertical.
- Drift is evidence, seam-wide: `provider_drift_sample` (source
  `fallback_selection`; `transport_fallback` typed but deferred) shares the same
  lossy evidence sink as the cache observation and is read by a projection-only,
  fail-closed inspect view; a same-model credential rotation is distinguished by
  the `credentialSlot`.
- Durability is typed: the `Durable`/`Lossy`/`Advisory` phantom brands and the
  `SawFrame`/`NoFrame` frame witness promote the durable/lossy split and the
  pre-first-frame fallback gate from convention into the type system, and the
  evidence sink demands `Lossy<object>`.
- Smaller borrowings landed: usage is non-overlapping with every wire-boundary
  subtraction clamped non-negative, transmitted secret values are scrubbed from
  the fingerprint hashes by value, and the `StreamFunction` terminal-error
  contract is documented.
- Three asymmetries where brewva already leads — schema-aware tool-call parse,
  vertical driver slices, and delta streaming — are preserved, not regressed
  toward the reference runtimes.

## Axioms

Obeys `docs/architecture/design-axioms.md`; the seam grammar (`Transport is
orthogonal. Quirks are data. Drift is evidence. Durability is typed.`) is a
corollary of the constitution, not a new axiom.

- Axiom 5 (`Every commitment has a receipt.`): fallback selection and drift stay
  inspectable after the turn through the drift sample and its projection.
- Axiom 16 (`Kernel contracts admit only correctness-bearing judgments.`): drift
  and cache evidence are lossy and never enter kernel or replay authority; the
  honesty types make a `Lossy` value structurally unable to reach a durable sink.
- Axiom 18 (`Descriptive metadata derives views, never authority.`): the quirks
  table is descriptive data and the drift inspect view is projection-only, so
  neither feeds an authoritative runtime decision.
- Axiom 14 (`Documentation hierarchy follows authority hierarchy.`): the
  layer-ownership matrix records who owns what without widening kernel authority.

## Non-goals

- No four-port runtime widening and no second truth store; drift is diagnosis,
  never a parallel replay authority.
- No DRY-collapse of the readable per-provider driver slices.
- The `transport_fallback` drift source stays typed but unemitted until a
  provider-core surface decision surfaces the Codex WebSocket-to-SSE latch.
