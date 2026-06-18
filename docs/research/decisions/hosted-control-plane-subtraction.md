# Decision: Hosted Control-Plane Subtraction — Single Runtime, Tape-Authoritative State, And Adapter Collapse

## Metadata

- Decision: The gateway hosted control plane collapses to one runtime per session lifecycle, tape-authoritative recoverable hosted state with no second source of truth, a narrowed hosted runtime adapter, and recovered zero-consumer substrate subpaths.
- Date: `2026-06-17`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/journeys/internal/hosted-behavior-installation.md`
  - `docs/reference/extensions.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-ports.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-turn-runtime.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/runtime-ops-projections.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.ts`
  - `packages/brewva-cli/src/runtime/cli-runtime-ports.ts`
  - `packages/brewva-substrate/package.json`

## Decision Summary

- One adapter-owned runtime per session: provider, tool, and authority physics
  route by session id via `registerTurnSession`; the per-session runtime swap and
  the `SESSION_RUNTIMES` map are deleted. `createRuntime` survives only as an
  independent harness-replay path.
- `RuntimeToolAuthorityResolver` takes a required `sessionId` (the kernel always
  supplies it); this is the only public runtime-surface change.
- Recoverable hosted state (taskSpec, taskItems, taskBlockers, resourceLeases,
  workbench, workerResults) is tape-authoritative: writes emit events only; reads
  go through a pure, cache-free projection layer; a fresh process rebuilds state
  from tape. context-evidence stays in-memory by design as performance-only
  state.
- The wide hosted runtime adapter no longer exposes `createRuntime` or a
  capabilities alias; CLI ops access is funneled through one fitness-locked seam,
  keeping the wide facade gateway-private.
- The hosted turn path has one canonical entry, `runHostedTurnEnvelope`; the
  managed-agent session is an orchestrator over extracted collaborators.
- `@brewva/brewva-substrate` drops the zero-consumer `./persistence`,
  `./provenance`, and `./execution` public subpaths; implementations stay
  substrate-internal.
- The architecture narrative carries one canonical ring topology
  cross-referenced between `system-architecture.md` and `design-axioms.md`.

## Axioms

This decision is judged against `docs/architecture/design-axioms.md`:

- Obeys axiom 3 (Subtraction beats switches): the second runtime, the wide
  adapter's `createRuntime` and capabilities surface, and the dead substrate
  subpaths are deleted, not kept behind toggles.
- Obeys axiom 6 (Tape is commitment memory): recoverable hosted state is
  replay-derived from tape, with no second in-memory source of truth.
- Obeys axiom 12 (Product loops are projections, not runtime state machines):
  hosted durable-state reads are pure projections over tape.
- Obeys axiom 15 (Public width should compress toward authority width): the
  hosted runtime adapter and the CLI ops surface narrow toward a single seam.
- Obeys axiom 11 (Same evidence is not shared authority): the CLI ops seam
  consumes projections; it does not gain runtime authority.
