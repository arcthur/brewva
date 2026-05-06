# System Architecture

Brewva is a commitment runtime.

Constitution:

`Intelligence proposes. Kernel commits. Tape remembers.`

Implementation reading:

`Intelligence explores. Kernel authorizes effects. Tape remembers commitments.`

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

- `Kernel Ring`: effect authorization, proposal decisions, verification,
  rollback receipts, replay, Recovery WAL, and event-tape truth.
- `Substrate Ring`: session lifecycle driving, turn orchestration, tool
  execution phases, prompt/context resource loading, and session persistence
  bridges.
- `Control Plane`: scheduling, gateway workers, channel orchestration,
  subagents, recovery loops, and other opt-in hosted behavior.
- `Experience Ring`: CLI, TUI, gateway clients, channels, and operator UX.
- `Deliberation Ring`: recall, precedent, narrative memory, model-facing
  guidance, and advisory search/delegation support.

Rings define authority. Package names may host code from more than one ring,
but public contracts should expose the narrowest ring that owns the decision.

## Operational Planes

Planes describe product behavior:

- `Working State Plane`: projection, context arena, active tool surface,
  workflow artifacts, and posture snapshots.
- `Cognitive Product Plane`: context composition, identity rendering,
  capability disclosure, and model-facing recovery hints.
- `Control Plane`: heartbeat, scheduling, hosted turns, subagents, and
  runtime-plugin orchestration.
- `Efficiency Plane`: token-cache policy, request fingerprints,
  read-unchanged reduction, and provider cache observations.

Planes do not create authority. If a plane conflicts with a ring, the ring
wins.

## State Taxonomy

- Durable source of truth: event tape and receipt-bearing runtime records.
- Durable recovery material: Recovery WAL, rollback snapshots, and session
  rewind checkpoints.
- Durable evidence: evidence ledger rows, verification reports, and audit
  events.
- Rebuildable state: working projection, session-wire frames, session lineage,
  context-entry paths, schedule projections, and derived workflow artifacts.
- Cache/local state: provider token cache, live UI state, process-local loop
  diagnostics, and performance-only helpers.

Behavior-changing state should be replay-derived. Visibility-changing state
should be projection-visible. Performance-only state may remain local.

Session lineage and context-entry projections explain work-branch topology and
model context admission, but they do not replace tape authority.

## Runtime Surface

`BrewvaRuntime` has three semantic roots:

- `runtime.authority`: commits replay-visible changes or explicit decisions.
- `runtime.inspect`: reads runtime state without mutating it.
- `runtime.maintain`: refreshes, rebuilds, registers, or recovers bounded
  operational surfaces.

The root runtime object is not a mixed implementation bag. Hosted sessions,
tools, and operators receive narrowed ports.

Runtime implementation ownership is sliced under
`packages/brewva-runtime/src/domain/<name>/`. Each domain owns its public seam,
type seam, registrar, event declarations, and runtime surface contribution
through explicit `api.ts`, `types.ts`, `registrar.ts`, and
`runtime-surface.ts` files. Cross-domain source imports go through those seams
instead of reaching into another domain's implementation files.

Repo-owned implementation-adjacent callers use branded controlled extension
ports or explicit runtime subpaths. The removed `internal` barrel, method-group
layer, and legacy assembler files are not compatibility surfaces.

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

New orchestration breadth that widens the default hosted or runtime-plugin path
must land as opt-in control-plane behavior or as an explicit exception with a
compatibility story.

## Package Map

- `@brewva/brewva-runtime`: kernel contracts, event tape, projection,
  verification, governance, cost, rollback, and WAL durability.
- `@brewva/brewva-substrate`: contract-only root vocabulary plus explicit
  mechanism subpaths for session lifecycle, prompt/resource loading,
  provenance, sequential execution primitives, pure compaction mechanics,
  host-facing tools, host plugin ports, provider execution adapters,
  persistence helpers, the turn-loop substrate, and a thin in-memory SDK
  composition entrypoint. The SDK assembles substrate mechanisms for direct
  hosts; it is not the gateway hosted policy owner, and compaction trigger or
  recovery policy remains above substrate.
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
  evidence, narrative/deliberation memory, promotion drafts, and repository
  precedent. Its root is shared vocabulary; broker/context/knowledge/evidence
  implementations use explicit subpaths.
- `@brewva/brewva-tools`: managed tool bundle and capability-scoped runtime
  facades.
- `@brewva/brewva-gateway`: hosted sessions, daemon, runtime plugins,
  subagents, and local control-plane orchestration.
- `@brewva/brewva-cli` and `@brewva/brewva-tui`: operator shell, one-shot CLI,
  renderer boundary, and terminal capability policy.
- `@brewva/brewva-deliberation`, `@brewva/brewva-skill-broker`, and
  `docs/solutions/**`: advisory memory, precedent, skill promotion, and
  compounding knowledge surfaces.
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
