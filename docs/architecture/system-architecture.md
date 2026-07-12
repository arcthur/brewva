# System Architecture

Brewva is a governed substrate for autonomous coding agents.

Constitution:

`Model owns attention. Kernel owns consequence. Tape owns truth. Runtime owns physics.`

This page is the overall architecture entry. Use it for authority ownership,
state taxonomy, and package-level boundaries. Use `docs/architecture/design-axioms.md`
for philosophy — including the implementation-grade reading of the constitution —
and `docs/architecture/invariants-and-reliability.md` for non-negotiable safety
properties.

## Interpretation Order

When architecture documents differ in tone or granularity, read them in this
order:

1. `docs/architecture/design-axioms.md`
2. `docs/architecture/invariants-and-reliability.md`
3. `docs/architecture/system-architecture.md`
4. companion diagrams or product-shape descriptions

Do not use broad plane or product language from companion docs to widen kernel
authority, durable control state, or default-path prescriptions.

## Product Shape

The default product loop is:

`receive -> orient -> authorize -> act -> verify -> continue`

This loop is a projection grammar over existing owners, not a runtime state
machine. `receive` comes from operator, channel, or hosted ingress; `orient`
renders Work Card and bounded baseline context; `authorize` presents capability
receipts, asks, and sandbox posture; `act` flows through kernel tool
transactions; `verify` surfaces advisory evidence or explicit verification
gates; `continue` may record replayable continuation anchors.

Shell, CLI, channel, and embedder inspect surfaces should share the same
schema-tagged projection payload where practical. Renderers may impose different
line budgets, but they should preserve canonical refs for drill-down instead of
creating separate product facts.

The rule is `same evidence, different authority`. A Work Card, SkillCard,
attention option, hook receipt, renderer, or continuation-anchor summary can
make evidence visible. None of them grants tool access, account authority,
budget, model routing, sandbox bypass, approval, adoption, or kernel admission.

## Authority Rings And Their Projections

Rings are the authority detail of the four-owner constitution: they refine who
owns what beneath those four owners. Rings are an explanatory
layer under the constitution, not a top-level axis above it; within that layer
they are the single coordinate system for authority, and projections are views
over them. This page carries the canonical, complete ring topology;
`docs/architecture/design-axioms.md` states the authority-bearing subset
(`Kernel Ring`, `Runtime Physics Ring`, `Runtime Turn Ring`,
`Deliberation Ring`, `Experience Ring`).

Each ring may expose a read-only projection that makes its state visible without
granting authority. A projection is a view over an owner, not a parallel
coordinate system.

| Ring (authority owner) | Owns                                                                                                                                                                     | Read-only projection           | Durable state class                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------- |
| `Model Attention Ring` | what the model reads, remembers, evicts, recalls, quotes, or compacts, exposed through ordinary model-callable tools                                                     | Workbench, Attention Options   | durable advisory material + request-local   |
| `Kernel Ring`          | effect authorization, proposal decisions, verification gates, rollback receipts, Recovery WAL, replay, event-tape truth                                                  | Authority                      | durable source of truth + recovery material |
| `Runtime Physics Ring` | context status, context-window limits, budget accounting, provider request constraints, durability classes, cache safety; does not choose attention for the model        | Efficiency                     | request-local + cache/local                 |
| `Runtime Turn Ring`    | execution within one accepted turn through `runtime.turn`: provider calls, tool-result continuation, retry, cache posture, cost, interruption, terminal commit           | — (execution edge)             | commits through `Kernel Ring`               |
| `Substrate Ring`       | between-turn session coordination: prompt admission, queue/follow-up ordering, host-local interaction phases, resource assembly, and resume handoff                      | Working projection             | rebuildable                                 |
| `Deliberation Ring`    | recall and precedent search, model-facing guidance, compact prompt templates, candidate preparation, advisory evaluation; does not commit effects or execute model calls | folds into Workbench / Options | rebuildable                                 |
| `Control Plane Ring`   | scheduling, gateway workers, channel orchestration, subagents, recovery loops, and other opt-in hosted behavior                                                          | Hosted Control                 | rebuildable                                 |
| `Experience Ring`      | CLI, TUI, gateway clients, channels, operator UX, memory operation visibility, cache/cost diagnostics, approval displays                                                 | Experience                     | cache/local                                 |

Package names may host code from more than one ring, but public contracts
should expose the narrowest ring that owns the decision. The `Substrate Ring`
is realized by host/session adapters using shared substrate contracts; the
similarly named `@brewva/brewva-substrate` package supplies vocabulary and
mechanisms but does not own turn execution. `runtime.turn` belongs only to the
`Runtime Turn Ring`.

A projection therefore grants none of the authorities listed under Product
Shape: because it carries no authority, there is no projection-versus-ring
conflict to arbitrate — the ring always owns the decision.

There is no default context-source admission path. The provider request shape
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

The session history model is linear-append + replay, single-writer per session:
each session's event tape is one append-only file with one writer, and undo / redo
/ rewind come from the replay / `PatchSet` engine, not tree navigation. Canonical
events carry an optional, additive `parentId` — the append-only hook for structural
branching — while sub-agent history stays per-session-isolated and is linked across
sessions by `parentSessionId`, not by a shared multi-writer log. A
multi-writer-with-CAS substrate is deliberately not built; only multi-host
distribution would trigger it, and even then as single-writer plus a selective lease
rather than a rewrite. See
`docs/research/decisions/tree-history-and-multi-writer-substrate.md`.

## Runtime Surface

Runtime construction uses `createBrewvaRuntime(...)`, which returns one frozen
four-port object:

- `runtime.tape`: committed truth, replay baselines, canonical events, and
  deterministic projections.
- `runtime.kernel`: tool authorization, approval requests, commitments, commit
  receipts, and abort receipts.
- `runtime.model`: prompt and working-memory materialization, and checkpoint
  candidate construction.
- `runtime.turn(...)`: provider streaming, context pressure, retry discipline,
  resource scheduling, interruption, cost observation, and terminal turn commit.

The public root also exposes `identity`, readonly `config`, `start()`, and
`close()`. It does not expose `root`, `hosted`, `tool`, `operator`,
`authority`, `inspect`, or Effect values.

Repo-owned hosted code that still needs implementation-adjacent helpers uses
the quarantined gateway hosted adapter. That adapter exposes one `ops` view and
explicit tool extensions; it is not a second public runtime API and must not
own turn truth, transition truth, or recovery policy. Managed tools receive a
capability-scoped runtime facade derived from declared `ops.*` and
`extensions.tools.*` paths.

The hosted turn adaptation splits along its one real physical boundary:
`hosted/edge/` owns the worker-process turn boundary — the parent/worker message
protocol and liveness heartbeat — while `hosted/internal/turn/` owns the
sequentially-coupled chain that feeds `runtime.turn` (envelope, frame projection,
hosted provider/tool/authority port construction). These are one execution
skeleton (`runtime.turn`) adapted for hosting, not duplicated turn layers; hook
lifecycle ports live separately under `hosted/internal/hooks/`. Session-level
task-stall detection and adjudication live under `hosted/internal/session/watchdog/`;
the edge worker starts and stops that policy but does not own it. Turn provider
construction consumes one validated `RuntimeProviderFace` capability rather than
probing optional methods on the managed session.

Runtime implementation ownership now lives under four semantic roots:
`runtime/tape`, `runtime/kernel`, `runtime/model`, and `runtime/turn`, with
read-only projections under a sibling `read-models/` root
(`read-models/projection/`). The former `domain/<name>/` seven-file
lattice is not a valid pattern for new runtime work.

## Effect Infrastructure Island

Effect is an infrastructure mechanics substrate, not the semantic runtime
spine. The runtime package remains ordinary TypeScript: no Effect services, no
Effect layers, no raw Effect imports, and no public Effect values on
`BrewvaRuntime`.

Effect owns resourceful mechanics in infrastructure islands: provider-core
stream production, gateway channel and daemon mechanics, tool execution process
management, substrate plugin callback guards, ingress, and worker operations.
Those islands use scoped services, dependency layers, finalizers, fibers,
streams, queues, schedules, retry policy, typed infrastructure failures, and
structural observability where they provide real leverage.

Effect does not create authority. A layer dependency means an implementation
needs a service; it never means a tool or plugin may access a runtime
capability. Capability-scoped runtime ports remain the only way hosted tools
and plugins gain runtime access.

Public edges stay Promise-friendly where appropriate. CLI commands, TUI
launch, HTTP handlers, Telegram/channel ingress, MCP calls, plugin callbacks,
and worker IPC run one Effect program per logical operation and translate
external `AbortSignal` cancellation once at that boundary. Internal queue,
stream, schedule, and registry mechanics stay Effect-native until a declared
adapter boundary.

Runtime turn handoff stays plain TypeScript. Producer-consumer paths that must
not import Effect use `@brewva/brewva-std/async` `createAsyncBridge(...)` for
bounded backpressure, abort, failure, close, and early-consumer-exit cleanup.

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

Source edits preserve this boundary. `source_patch_prepare` is validation and
planning only; `source_patch_apply` is the single source mutation gate, records
the rollback-bearing `PatchSet`, and is the path used by real LSP
`WorkspaceEdit` writes and worker-result adoption.

Brewva does not currently provide a stable contract for generalized
compensation graphs, automatic partial-failure repair across delegated runs,
or default-path backpressure guarantees across the broader control plane.

No cross-agent saga semantics.
No generalized compensation graphs.

New orchestration breadth that widens the default hosted or extension path
must land as opt-in control-plane behavior or as an explicit exception with a
compatibility story.

## Self-Improvement Loop

The harness runs a self-improvement loop whose permission layer stays OUTSIDE the
loop. The loop may contain measurement, reports, and proposals; it never contains
rule authorship or approval-policy authorship. Receipt-bearing loops feed it —
advisory calibration, harness candidates, learnings promotion, the
`schedule.selfImprove` heartbeat, independent review, replay-distilled precedent —
and all share one governance shape:

- **Measure, then propose, never mutate.** Every advisory heuristic records a tape
  receipt with an honest `source`, and an offline recipe
  (`analyze:advisory-receipts`, `report:self-eval`) derives reports from the tape
  only. Recipes derive reports; rule changes land as reviewed code (the
  advisory-receipt-and-calibration-standard decision; axiom 2).
- **A decidability instrument (built, not yet run).** `report:self-eval` drives a
  fixed set of headless tasks and reads per-run tape metrics, so "did this harness
  change help" CAN be checked from the tape rather than asserted — the loop's
  decidability condition once a corpus is run (offline; no corpus has been run
  yet). Its fixtures and scoring join the frozen evaluator surface, never
  candidate-mutable.
- **A named action surface (the membership fence).** The calibration parameter
  registry is the single declarative list of WHICH parameters are
  calibration-eligible — the only candidate-tunable surface; everything outside it
  is frozen by default. Its statuses (`asserted` / `calibrated` / `contested`) are
  the honesty grade, without granting authority (axiom 18) — today all are
  `asserted` (unexercised). It fences the NAMES, not yet a per-parameter admissible
  range; bounding each parameter's domain is the extension a future proposer needs.
- **Negotiated authority, not assumed.** An unattended run that feeds the loop
  negotiates its approval authority through a declared config envelope carrying an
  audit-trail receipt — the first axiom-9 precedent (the unattended-run
  approval-provenance decision), not hidden privilege escalation.

Promotion — moving a proposal, calibration, or candidate into the product — stays
a reviewed human act. The registry, the frozen evaluator, and the permission layer
are the fence that keeps a future optimizer phase reviewable rather than
open-ended; the runtime holds no promotion authority.

## Package Map

- `@brewva/brewva-runtime`: the four-port runtime root, canonical tape, kernel
  tool transactions, model materialization, runtime turn implementation, deterministic
  tape projections.
- `@brewva/brewva-effect`: internal Effect foundation package. It owns Effect
  platform dependencies, boundary runners, scoped resource and schedule
  helpers, typed infrastructure errors, config service helpers, retry policy,
  observability adapters, and test utilities. Its root entrypoint is
  boundary-oriented, while Effect primitive aliases remain explicit through the
  `@brewva/brewva-effect/primitives` subpath.
- `@brewva/brewva-std`: dependency-free standard primitives shared across
  packages — the async bridge and bounded backpressure
  (`@brewva/brewva-std/async` `createAsyncBridge`), backoff, hashing, JSON, math,
  text, collections, and the `Durable`/`Lossy`/`Advisory` honesty brands. It is
  foundation utility, not authority, replay, or provider mechanism.
- `@brewva/brewva-substrate`: contract-only root vocabulary plus explicit
  mechanism subpaths for session lifecycle vocabulary, prompt/resource loading,
  pure context-budget derivation, token-aware compaction cut-point selection,
  pure compaction mechanics, host-facing tools, tool protocol vocabulary, host
  plugin ports, and agent-protocol message vocabulary. Substrate assembles
  mechanisms for direct hosts; it is not the gateway hosted effect owner, does
  not execute model calls, does not own the turn loop, and does not own
  compaction trigger or recovery policy. Host adapters use these mechanisms for
  `Substrate Ring` coordination between turns; `runtime.turn` remains the sole
  implementation of `Runtime Turn Ring` execution.
- `@brewva/brewva-vocabulary`: shared product vocabulary contracts used across
  hosted, tools, recall, session-index, and channel packages. It is contract-only
  naming, not runtime authority.
- `@brewva/brewva-provider-core`: provider contracts, model catalog lookup,
  provider registration, stream normalization, cache rendering, and driver
  adapters. It is mechanism, not replay or credential authority.
- `@brewva/brewva-token-estimation`: model token-estimation primitives for
  context-budget and request sizing. It is estimation mechanism, not budget or
  context authority.
- `@brewva/brewva-search`: shared search normalization, CJK segmentation, and
  semantic query/content tokenization policy. It does not own event evidence,
  session-index state, or recall ranking.
- `@brewva/brewva-session-index`: rebuildable SQLite + FTS5 read model over
  session event tapes. It owns indexed evidence projection and typed query rows,
  while event tape remains runtime replay authority.
- `@brewva/brewva-recall`: source-typed recall over session-index tape evidence
  and repository precedent. Recall is an on-demand tool substrate, not a
  per-turn context admission pipeline.
- `@brewva/brewva-tools`: family-sliced managed tool adapters, centralized
  managed-tool capability registry, capability-scoped runtime facades,
  controlled runtime-port helpers, attention option tools, source snapshot and
  patch-plan gates, real LSP adapters, and default bundle assembly. It does not
  own hosted orchestration or model routing policy.
- `@brewva/brewva-gateway`: hosted sessions, daemon, hosted extensions,
  subagents, local control-plane orchestration, hosted provider execution,
  cache-aware request shaping, verification-gate policy bridging, and
  LLM-driven compaction.
- `@brewva/brewva-cli`: operator shell, one-shot CLI, CLI-internal renderer
  boundary, Work Card projection assembly, and terminal capability policy.
- `docs/solutions/**` and knowledge tools: repository precedent and
  compounding knowledge surfaces. Deliberation remains an architecture ring, not
  a standalone package.
- channel, ingress, and MCP adapter packages: external transport and protocol
  adapters.

## Reading Guide

- Flow snapshots: `docs/architecture/control-and-data-flow.md`
- Product-facing model/operator/kernel boundary:
  `docs/architecture/cognitive-product-architecture.md`
- Effect-governance rationale companion:
  `docs/architecture/exploration-and-effect-governance.md`
- Runtime contract: `docs/reference/runtime.md`
- Tool contract: `docs/reference/tools.md`
- Proposal boundary: `docs/reference/proposal-boundary.md`
