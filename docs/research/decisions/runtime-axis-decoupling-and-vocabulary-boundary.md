# Decision: Runtime Axis Decoupling And Vocabulary Boundary

## Metadata

- Decision: runtime construction makes physics explicit, keeps observation as an isolated harness seam, moves shared product vocabulary out of runtime/protocol, and makes hosted runtime ops consume typed capability adapters instead of owning four-port authority.
- Date: `2026-05-25`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/runtime-subpaths.json`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/runtime-api.ts`
  - `packages/brewva-runtime/src/runtime/turn/physics.ts`
  - `packages/brewva-runtime/src/runtime/kernel/observation.ts`
  - `packages/brewva-vocabulary/src/`
  - `packages/brewva-tools/src/runtime-port/four-port-capabilities.ts`
  - `packages/brewva-tools/src/runtime-port/four-port/`
  - `packages/brewva-tools/src/contracts/runtime.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-ops.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-port.ts`
  - `script/generate-tool-runtime-capability-inventory.ts`
  - `test/fitness/runtime-ops-capability-inventory.fitness.test.ts`

## Decision Summary

- Runtime physics is an explicit required declaration. `real`, `replay`, `replay-then-real`, and `noop` modes are constructed without implicit provider fallbacks or hidden execution defaults.
- Observation is a cross-cutting harness seam. Kernel interceptors and materialization observation run in isolated contexts and cannot mutate canonical tape facts.
- `@brewva/brewva-vocabulary` owns shared event, wire, task, schedule, context, workbench, delegation, iteration, and session vocabulary through subpath-only exports.
- `@brewva/brewva-runtime/protocol` stays deleted; product vocabulary no longer grows through runtime.
- Hosted `runtime.ops` namespaces are physically split by builder, labeled by destination, and guarded by fitness budgets.
- A-labeled hosted ops namespaces delegate to four-port capability adapters under `@brewva/brewva-tools/runtime-port`; gateway builders no longer implement cost, events, lifecycle, recovery, or tape authority.
- `BrewvaToolRuntimeCapabilitiesPort` is the typed source for tool-visible runtime capability paths, and hosted ops composes it with hosted-only extensions instead of mirroring the whole surface.
- Capability inventory generation derives managed capability strings mechanically from the typed tools capability source and explicit tools extensions.
- Replay harness value is part of the accepted contract: deterministic replay, replay-then-real divergence, shadow evaluation, and replay-equivalence CI gates are first-class validation targets.

## Acceptance Evidence

- The former active blockers are closed: A-labeled hosted ops namespaces are thin delegates to four-port adapters, and hosted ops composes the typed tools capability source instead of mirroring it.
- Runtime `./protocol` stays deleted, vocabulary is subpath-only, and vocabulary internals are domain-sliced with fitness budgets.
- Runtime physics, observation, topology, model materialization, runtime subpath ownership, and hosted ops compression are each guarded by targeted fitness tests.
- Net source delta across the affected runtime, gateway, tools, recall, session-index, and CLI packages is negative in the implementing diff.

## Supersedes

- The vocabulary-boundary and runtime-ops portions of `docs/research/decisions/four-port-runtime-simplification-rfc.md`.

## Superseded by

- None.
