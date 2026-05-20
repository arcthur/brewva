---
strength: invariant
scope: anti-patterns
convention_kind: workflow_rule
retirement_sensitivity: review_only
---

# Brewva Anti-Patterns

- Cross-package relative imports such as `../../packages/...`.
- Alias-based import models outside package entrypoints.
- `as any`, `@ts-ignore`, or `@ts-expect-error` quick fixes.
- A mixed top-level runtime implementation surface or bypasses around semantic root surfaces.
- Importing Effect, Effect primitive aliases, Effect services, or Effect layers
  into `@brewva/brewva-runtime`.
- Calling `runBoundaryOperation` from provider stream core, channel queue core,
  tool execution internals, or runtime package code instead of from a declared
  adapter boundary.
- Hand-rolling package-local Scope/ManagedRuntime adapter assemblies for
  long-lived infrastructure services when `createBrewvaServiceRuntime(...)`
  provides the shared scoped service boundary.
- Reintroducing module-level managed exec process registry ownership, default
  registry singletons, per-runtime fallback registry WeakMaps, or exported
  global process-session maps.
- Using ad hoc async queues for runtime provider/tool handoff where
  `createAsyncBridge(...)` is the accepted backpressure and cancellation seam.
- Reintroducing or presenting removed `@brewva/brewva-runtime/internal` helpers as a default integration surface or stable product contract.
- Passing full gateway hosted adapter bundles into leaf modules that only need a
  hosted, tool, or operator port.
- Adding managed-tool runtime calls without updating `requiredCapabilities` metadata and scoped-runtime tests.
- Treating `.brewva/session-index/session-index.duckdb` as source-of-truth memory or replay authority.
- Adding user-facing SQL surfaces over the session index before a typed API exists for the product need.
- Adding package-local search tokenizers or optional Chinese-tokenizer fallbacks outside `@brewva/brewva-search`.
- Authoring a second schema source for provider tool arguments instead of
  deriving advisory streaming parse from the canonical TypeBox schema.
- Exporting provider-core streaming parse projection helpers such as
  `partialize` or registry construction as root public APIs.
- Reintroducing mixed provider-core root implementation files or flat
  provider-driver siblings when the accepted shape is domain slices plus
  `providers/<api>/`.
- Importing `@brewva/brewva-provider-core/stream` directly from gateway modules
  outside `packages/brewva-gateway/src/hosted/internal/provider/execution-port.ts`.
- Reintroducing `@brewva/brewva-box`, `@brewva/brewva-tui`, or generic
  `@brewva/brewva-ingress` package identities without a new accepted ownership
  decision.
- Importing concrete Telegram channel packages from gateway modules outside the
  Telegram bridge composition.
- Letting `@brewva/brewva-mcp-adapter` decide managed-tool capabilities or
  hosted action policy instead of only translating MCP protocol surfaces.
- Fire-and-forget provider session cleanup on session replacement, rewind,
  compaction, or model/provider change.
- Re-exposing removed low-level tuning knobs as public config.
- Reintroducing runtime-stored context evidence slots or legacy
  `prompt.getStability`, `prompt.getTransientReduction`, and
  `providerCache.getObservation` ports.
- Reintroducing hosted context materialization plan/commit DAGs instead of
  direct lifecycle calls owned by hosted context modules.
- Writing history-view baseline artifact files as compaction authority instead
  of deriving baseline state from `session_compact` receipts.
- Editing generated distribution artifacts by hand.
- Skipping `test:dist` for export, CLI, or distribution changes.
