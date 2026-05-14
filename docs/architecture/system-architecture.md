# System Architecture

Brewva is a governed substrate for autonomous coding agents.

Constitution:

`Model owns attention. Kernel owns consequence. Tape owns truth. Runtime owns physics.`

Implementation reading:

`Model curates working memory. Kernel authorizes effects. Tape preserves
committed facts and compact baselines. Runtime enforces context-window, cache,
cost, provider, durability, and recovery constraints.`

This page is the overall architecture entry. Use it for authority ownership,
state taxonomy, and package-level boundaries. Use `docs/architecture/design-axioms.md`
for philosophy and `docs/architecture/invariants-and-reliability.md` for
non-negotiable safety properties.

## Interpretation Order

When architecture documents differ in tone or granularity, read them in this
order:

1. `docs/architecture/design-axioms.md`
2. `docs/architecture/invariants-and-reliability.md`
3. `docs/architecture/system-architecture.md`
4. companion diagrams or product-shape descriptions

Do not use broad plane or product language from companion docs to widen kernel
authority, durable control state, or default-path prescriptions.

## Authority Rings

- `Model Attention Boundary`: the model decides what to read, remember, evict,
  recall, quote, or compact. This is not a package ring; it is the cognitive
  ownership boundary exposed through ordinary model-callable tools.
- `Kernel Ring`: consequence-bearing authority only: effect authorization,
  proposal decisions, verification gates, rollback receipts, Recovery WAL,
  replay, and event-tape truth.
- `Runtime Physics Ring`: derived context status, context-window limits,
  budget accounting, provider request constraints, durability classes, and
  cache safety. It nudges or fails closed at physical limits; it does not choose
  attention for the model.
- `Gateway Model Boundary`: the only boundary that executes model calls. Main
  turns, LLM-driven compaction, model routing, provider cache policy, and usage
  accounting pass through gateway-owned provider execution.
- `Substrate Ring`: session lifecycle, turn orchestration, tool execution
  phases, request materialization primitives, checkpoint/resume mechanics, and
  session persistence bridges. Substrate may prepare requests; it does not call
  models or own salience.
- `Deliberation Ring`: recall search, precedent search, model-facing guidance,
  compact prompt templates, candidate preparation, and advisory evaluation. It
  may produce candidates and prompts, but it does not commit effects or execute
  model calls.
- `Control Plane`: scheduling, gateway workers, channel orchestration,
  subagents, recovery loops, and other opt-in hosted behavior.
- `Experience Ring`: CLI, TUI, gateway clients, channels, operator UX, memory
  operation visibility, cache/cost diagnostics, and approval displays.

Rings define authority. Package names may host code from more than one ring,
but public contracts should expose the narrowest ring that owns the decision.

## Operational Planes

Planes describe product behavior:

- `Authority Plane`: receipts, event tape, Recovery WAL, rollback snapshots,
  approval claims, verification evidence, and replay-visible commitments.
- `Workbench Plane`: model-authored notebook entries, evictions, source
  references, preserved quotes, on-demand recall results selected by the model,
  and sanitized compact baselines. It is provenance-bearing and inspectable,
  but it is not kernel authority.
- `Efficiency Plane`: stable prefix identity, provider cache policy, request
  fingerprints, request-local reductions, numeric context status, cache edit
  application, and provider cache observations.
- `Hosted Control Plane`: heartbeat, scheduling, hosted turns, subagents,
  channel adapters, and hosted extension orchestration. It is opt-in behavior,
  not the default cognitive path.
- `Experience Plane`: operator display, approval UX, inspect views, transcript
  rendering, and cache/cost/memory diagnostics.

Planes do not create authority. If a plane conflicts with a ring, the ring
wins.

There is no default context-source admission plane. The provider request shape
is stable contracts plus active workbench, explicit model-requested details,
and a small dynamic status tail.

## State Taxonomy

- Durable source of truth: event tape and receipt-bearing runtime records.
- Durable recovery material: Recovery WAL, rollback snapshots, sanitized
  compaction baselines referenced by digest, and session rewind checkpoints.
- Durable evidence: evidence ledger rows, verification reports, and audit
  events.
- Durable advisory material: model-authored workbench operation records,
  source references, preserved quotes, and promotion candidates. These may
  influence future attention, but they do not authorize effects.
- Rebuildable state: working projection, session-wire frames, session lineage,
  workbench views, schedule projections, and derived workflow artifacts.
- Request-local state: provider-visible dynamic tails, explicitly requested
  recall results, capability details, and transient reductions.
- Cache/local state: provider token cache, live UI state, process-local loop
  diagnostics, and performance-only helpers.

Behavior-changing state should be replay-derived. Visibility-changing state
should be projection-visible. Performance-only state may remain local.

Replay uses stored sanitized compaction baselines. It does not regenerate a
different summary with a newer model.

## Runtime Surface

Runtime construction uses `createBrewvaRuntime(...)`, which returns a frozen
explicit-port instance. Its `root` port has two semantic surfaces:

- `root.authority`: commits replay-visible changes or explicit decisions.
- `root.inspect`: reads runtime state without mutating it.

Repo-owned hosted and operator ports additionally expose `operator` for
bounded refresh, rebuild, registration, recovery, credential-binding, and
host-observation operations. Managed tools receive the separate tool port and
never receive the operator port. Holding `BrewvaRuntimeRoot` is not sufficient
to recover hosted, tool, operator, or Effect-spine access.

The root runtime object is not a mixed implementation bag. Composition roots may
hold the full instance; leaf modules receive narrowed ports.

Runtime implementation ownership is sliced under
`packages/brewva-runtime/src/domain/<name>/`. Each domain owns its public seam,
type seam, registrar, event declarations, and runtime surface contribution
through explicit `api.ts`, `types.ts`, `registrar.ts`, and direct
`runtime-surface.ts` files. Cross-domain source imports go through those seams
instead of reaching into another domain's implementation files.

Repo-owned implementation-adjacent callers use typed controlled extension ports
or explicit runtime subpaths. Those ports do not carry runtime capability
tokens. The removed `internal` barrel, method-group layer, and legacy assembler
files are not compatibility surfaces.

## Effect Runtime Spine

Effect is the internal runtime mechanics substrate for long-running effectful
execution. It owns dependency layers, scopes, fibers, streams, schedules,
typed runtime errors, and structural observability in the runtime, substrate,
gateway, tools, and provider execution paths.

Effect does not create authority. A layer dependency means an implementation
needs a service; it never means a tool or plugin may access a runtime
capability. Capability-scoped runtime ports remain the only way hosted tools
and plugins gain runtime access.

Public edges stay Promise-friendly where appropriate. CLI commands, TUI
launch, HTTP handlers, Telegram/channel ingress, MCP calls, plugin callbacks,
and worker IPC run one Effect program per logical operation and translate
external `AbortSignal` cancellation once at that boundary.

The foundation package wires Effect spans and log annotations structurally. The
default observability layer is inert until configured, and the Node runtime path
can attach `@effect/opentelemetry` `NodeSdk` processors without importing Node
platform adapters into Worker-oriented edge code.

## Transaction Boundary

The current stable authority-bearing transaction boundary is `single tool
call`.

Brewva provides durable semantics for:

- tool-call classification
- proposal, approval, and exact resume
- linked tool outcomes
- rollback-bearing mutation receipts where supported

Brewva does not currently provide a stable contract for generalized
compensation graphs, automatic partial-failure repair across delegated runs,
or default-path backpressure guarantees across the broader control plane.

No cross-agent saga semantics.
No generalized compensation graphs.

New orchestration breadth that widens the default hosted or extension path
must land as opt-in control-plane behavior or as an explicit exception with a
compatibility story.

## Package Map

- `@brewva/brewva-runtime`: kernel contracts, event tape, projection,
  verification, governance, cost, rollback, workbench operation records,
  numeric context status, and WAL durability.
- `@brewva/brewva-effect`: internal Effect foundation package. It owns Effect
  platform dependencies, boundary runners, scope/schedule helpers, typed
  runtime errors, runtime spine helpers, config service helpers, and
  observability adapters. Its root entrypoint is a thin re-export spine, with
  explicit internal subpaths for platform adapters, runtime spine, edge runners,
  and test utilities. Other packages import Effect primitives only through this
  package.
- `@brewva/brewva-substrate`: contract-only root vocabulary plus explicit
  mechanism subpaths for session lifecycle, prompt/resource loading,
  provenance, sequential execution primitives, pure compaction mechanics,
  host-facing tools, tool protocol vocabulary, host plugin ports, persistence
  helpers, the turn-loop substrate, and a thin in-memory SDK composition
  entrypoint. The SDK assembles substrate mechanisms for direct hosts; it is not
  the gateway hosted policy
  owner, does not execute model calls, and does not own compaction trigger or
  recovery policy.
- `@brewva/brewva-provider-core`: provider contracts, model catalog lookup,
  provider registration, stream normalization, cache rendering, and driver
  adapters. It is mechanism, not replay or credential authority.
- `@brewva/brewva-search`: shared search normalization, CJK segmentation, and
  semantic query/content tokenization policy. It does not own event evidence,
  DuckDB state, or recall ranking.
- `@brewva/brewva-session-index`: rebuildable DuckDB read model over session
  event tapes. It owns indexed evidence projection and typed query rows, while
  event tape remains runtime replay authority.
- `@brewva/brewva-recall`: source-typed recall products over session-index
  evidence, workbench-admitted memory, promotion drafts, and repository
  precedent. Recall is an on-demand tool substrate, not a per-turn context
  admission pipeline.
- `@brewva/brewva-tools`: family-sliced managed tool adapters, centralized
  managed-tool capability registry, capability-scoped runtime facades,
  controlled runtime-port helpers, and default bundle assembly. It does not own
  hosted orchestration or model routing policy.
- `@brewva/brewva-gateway`: hosted sessions, daemon, hosted extensions,
  subagents, local control-plane orchestration, hosted provider execution,
  cache-aware request shaping, and LLM-driven compaction.
- `@brewva/brewva-cli`: operator shell, one-shot CLI, CLI-internal renderer
  boundary, and terminal capability policy.
- `docs/solutions/**` and knowledge tools: repository precedent and
  compounding knowledge surfaces. Deliberation remains an architecture ring, not
  a standalone package.
- channel and ingress packages: external transport adapters.

## Reading Guide

- Flow snapshots: `docs/architecture/control-and-data-flow.md`
- Product-facing model/operator/kernel boundary:
  `docs/architecture/cognitive-product-architecture.md`
- Effect-governance rationale companion:
  `docs/architecture/exploration-and-effect-governance.md`
- Runtime contract: `docs/reference/runtime.md`
- Tool contract: `docs/reference/tools.md`
- Proposal boundary: `docs/reference/proposal-boundary.md`
