# Decision: Gateway Hosted Lane Consolidation

## Metadata

- Decision: gateway default hosted execution is one hosted lane, and host extensions are opt-in only
- Date: `2026-05-12`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/reference/token-cache.md`
  - `docs/reference/artifacts-and-paths.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/api.ts`
  - `packages/brewva-gateway/src/hosted/session.ts`
  - `packages/brewva-gateway/src/hosted/thread-loop.ts`
  - `packages/brewva-gateway/src/hosted/provider.ts`
  - `packages/brewva-gateway/src/hosted/compaction.ts`
  - `packages/brewva-gateway/src/hosted/context.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/init/orchestration.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/`
  - `packages/brewva-gateway/src/hosted/internal/compaction/`
  - `packages/brewva-gateway/src/hosted/internal/context/`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/`
  - `packages/brewva-gateway/src/hosted/internal/shared/`
  - `packages/brewva-gateway/src/extensions/api.ts`
  - `test/fitness/gateway/hosted-lane-layout.fitness.test.ts`
  - `test/fitness/gateway/gateway-root-export-snapshot.fitness.test.ts`

## Decision Summary

- `@brewva/brewva-gateway/hosted` is the canonical public lane for hosted session creation and hosted turn execution.
- The old `@brewva/brewva-gateway/host`, `@brewva/brewva-gateway/session`, and `@brewva/brewva-gateway/runtime-plugins` package subpaths are deleted, not shimmed.
- Default hosted behavior no longer lives in a runtime-plugin family. The former context, evidence, lifecycle, provider, and tools families were absorbed under the hosted session and hosted thread-loop owner paths.
- `@brewva/brewva-gateway/extensions` is the opt-in host extension facade for CLI command extensions, explicit tool registration, local hooks, and advisory transforms. It is not the implementation language for default hosted behavior.
- Top-level hosted files are public facades. Side-effect ownership is enforced at the implementation paths that write receipts or mutate hosted state:
  - hosted session assembly, projection, tools, and bootstrap under `hosted/internal/session/`
  - provider payload and cache policy under `hosted/internal/provider/`
  - turn envelope, recovery decisions, lifecycle, and worker behavior under `hosted/internal/thread-loop/`
  - compaction generation and recovery under `hosted/internal/compaction/`
  - hosted context and context evidence under `hosted/internal/context/`
  - pure cross-owner contracts under `hosted/internal/shared/`
- Hosted behavior installation is private to session assembly through `createHostedBehaviorHostAdapter` from `hosted/internal/session/host-api-installation.ts`; there is one production call site in `hosted/internal/session/init/orchestration.ts`.
- `session-factory.ts` is the private session utility surface for tool definitions, model catalog creation, and hosted routing defaults. `session-assembly.ts` remains the only hosted session creation path.
- The remaining `session-runtime.ts`, `local-session-services.ts`, and `session-services.ts` files are accepted as private session composition, not as backend or driver adapter seams. Reintroducing a second backend adapter requires a new active note.
- Substrate may keep `InternalHostPlugin` vocabulary internally for its low-level host-api runner. Gateway public API must expose only hosted extension vocabulary.
- Quality tests lock the accepted shape by rejecting old hosted source families, nested `internal/internal`, create-session aliases, shallow internal pass-through files, old package subpaths, and hosted receipt writers outside declared owner paths.

## Superseded by

- None.
