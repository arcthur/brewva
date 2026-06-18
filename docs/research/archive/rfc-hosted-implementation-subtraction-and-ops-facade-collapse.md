# RFC: Hosted Control-Plane Subtraction — Single Runtime, Tape-Authoritative State, And Adapter Collapse

## Metadata

- Status: `archived`
- Accepted as: `docs/research/decisions/hosted-control-plane-subtraction.md` (2026-06-17)
- Implementation state: WS0–WS6 all landed on branch
  `claude/interesting-dirac-5e77d9` (committed, full `bun test` + `bun run check`
  green). WS3: `createRuntime` removal, capabilities-alias fold, CLI ops-seam
  narrowing. WS4: turn convergence was already satisfied by
  `runHostedTurnEnvelope`; the session god object was reduced by extracting its
  pure-helper clusters. WS5: the architecture-owner elected to recover the
  zero-consumer substrate seams — `./persistence`/`./provenance`/`./execution`
  public subpaths removed, implementations kept internal (see per-WS notes).
- Owner: Gateway and runtime maintainers
- Last reviewed: `2026-06-15`
- Promotion target:
  - `docs/architecture/system-architecture.md` (Runtime Surface, hosted adapter, State Taxonomy)
  - `docs/architecture/invariants-and-reliability.md` (projection integrity in the hosted layer)
  - `docs/architecture/design-axioms.md` (implementation note on internal width)
  - new records under `docs/research/decisions/`

## Problem Statement

Brewva's authority surface is already excellent and should not be re-designed.
The constitution (`Model owns attention. Kernel owns consequence. Tape owns
truth. Runtime owns physics.`) is fixed in 17 axioms and enforced by fitness
tests. The public runtime is a genuine four-port object: `createBrewvaRuntime`
exposes eight members, the old `domain/<name>/` lattice is gone, and no
`hosted`/`operator`/`authority`/`inspect` properties linger. Core runtime
ownership is lean (~12k LOC).

The unfinished work is one layer down, in the gateway hosted control plane. It
does not need another global refactor; it needs one convergence pass focused on
deletion, narrowing consumers, and unifying the source of truth. Three root
causes — not just surface ceremony — sit under the symptoms:

1. **A second runtime.** `HostedRuntimeAdapterPort` exposes `runtime`, `ops`,
   `capabilities`, `extensions`, and a mutable `createRuntime`. Its `ops` member
   has ~21 namespaces and effectively re-projects the entire gateway
   implementation as an interface — close in width to the old runtime facade the
   four-port work deleted.
2. **Two runtime instances per session lifecycle.** A session first holds an
   identity/config-only shell; the real `mode:"real"` runtime is built later, on
   the turn path, and stashed in a `WeakMap`. This produces runtime-replacement
   lifecycle, mutable `createRuntime` semantics, cross-instance tape visibility,
   and unclear `close` ownership.
3. **Hosted state lives in both Maps and Tape.** ~18 in-process Map/Set fields
   hold task, workbench, worker-result, resource-lease, and context-evidence
   state. Mutations usually emit a durable event, but several reads consult the
   Map directly (or fall back to it), and the Maps are not hydrated from tape on
   restart. The Map is therefore a second source of truth, which conflicts with
   "behavior-changing state should be replay-derived".

Root cause 3 is the important correction to an earlier framing of this note:
the ops facade is not pure, authority-free ceremony. It carries
non-replay-derived truth, so collapsing it is a behavior correction, not a
zero-risk pass-through flatten.

## Scope Boundaries

In scope:

- collapsing the two per-session runtime instances into one
- making recoverable hosted state tape-authoritative (write events, read
  projections, rebuild on recovery; Maps become rebuildable caches only)
- retiring `HostedRuntimeAdapterPort` as a general dependency in favor of
  use-case-scoped narrow ports; making `ops` gateway-private, then deleting it
- converging the hosted turn path into one readable module
- recovering substrate seams that have no second production consumer
- compressing the architecture narrative and removing stale doc references
- characterization ("behavior lock") tests as a prerequisite gate

Out of scope:

- any change to the four-port runtime root or its eight public members
- any change to kernel authority, approval binding, rollback, or replay
  semantics
- any change to wire protocols (ACP/MCP, gateway control-plane protocol)
- moving replay authority from tape/receipts into projection caches
- adding model-facing or operator-facing concepts, fields, or inspect views
- deleting authority/replay/package-dependency fitness tests (these guard the
  constitution and stay)

Coordinated with sibling RFCs (referenced, not owned here):

- compaction-orchestrator merge: owned by
  `rfc-context-operating-system-and-compaction-physics.md`
- approval/rollback storage de-duplication: owned by
  `rfc-effect-approval-and-rollback-closure.md`

## Why

The conceptually harder `delegation` subsystem fits in ~9.5k LOC, while the
hosted subtree spends ~21k LOC, much of it on adapter width, state plumbing, and
a runtime-replacement lifecycle. That accretion raises the cost of every hosted
change, hides the few decisions that matter, and — through root cause 3 —
silently loses recoverable state on restart. The target end state is a hosted
path that reads in one direction:

`Ingress -> Hosted Session -> Runtime Turn -> Receipts -> Projection`

instead of today's:

`Ingress -> Hosted Adapter -> Ops Facade -> Session Machinery -> Turn Envelope
-> Runtime Resolver -> Runtime Adapter -> Runtime Turn -> Projection Facade`

## Convergence Posture And Exit Criteria

An external review framed brewva as "oscillating, not converging" — building
things then tearing them down on a treadmill. A neutral audit of the decision
record does not support that framing. The Effect change was a 6-day boundary
correction (`effect-native-runtime-foundation` 2026-05-07 ->
`effect-infrastructure-island-boundary-rfc` 2026-05-20), not a build-then-delete:
the Effect packages were never ripped out, the boundary was drawn tighter and
stuck. `four-port-runtime-simplification-rfc` superseded five prior
runtime-shape decisions, but the runtime root moved monotonically from 60+
exports to 8 and never re-expanded. No decision in the record reverses a prior
deletion. The dominant pattern is disciplined monotonic narrowing, not
back-and-forth.

The valid part of that review still binds this RFC: governance volume is itself
a cost, and a new RFC can feed the treadmill. So this note is scoped as a
convergence pass with an explicit end, not an open-ended workstream:

- WS0-WS2 are correctness. They fix the single-runtime lifecycle and the
  invariant-9/12 violation (recoverable state silently lost on restart); they
  are not optional taste refactors.
- WS3-WS6 are convergence subtraction. When they land, the gateway hosted layer
  has reached its target shape and is declared converged: no further
  hosted-shape decisions, and the count-based invariants freeze the result.
- The core (constitution, four-port runtime, safety invariants) is already
  converged and is explicitly out of scope. `createBrewvaRuntime` is ~224 lines
  and should not be touched.

## Direction

Land in blast-radius order. Each workstream is independently revertible.

- **WS0 — Behavior locks (prerequisite gate).** Add characterization tests that
  pin observable behavior for interactive, approval-resume, compaction-resume,
  scheduled, and delegated turns before any refactor. No structural change lands
  until these are green and stable.
- **WS1 — One runtime per session lifecycle.** Assemble provider, tool
  executor, and authority resolver first, then create the runtime once
  (`assemble physics -> create runtime -> start -> turn* -> close`). Delete
  `createRuntime` replacement, the shell-to-real mutation, and `SESSION_RUNTIMES`
  bypass ownership. The `noop` mode survives only for explicit test or
  inspect-only paths. (correctness)
- **WS2 — Tape-authoritative hosted state.** For task, workbench, worker
  results, resource leases, and context evidence: writes emit events only; reads
  go through pure projectors; recovery rebuilds from tape. Caches/cursors are
  allowed but must be droppable and rebuildable, never fallback truth. This
  fixes the invariant-9/12 violation. (correctness, highest value)
- **WS3 — Retire the wide adapter.** Stop handing the whole
  `HostedRuntimeAdapterPort` to CLI, channels, and delegation. Inject narrow,
  use-case-scoped ports (hosted turn execution, approval desk, session
  inspection, task/workbench projection, control-plane receipts). Make `ops`
  gateway-private, then delete the second runtime. This absorbs the original
  "collapse the ops facade indirection" idea as one step of a larger retirement.
- **WS4 — One hosted turn module.** Converge the turn path to
  `HostedTurn.execute` (prepare prompt -> apply trigger -> call runtime.turn ->
  project frames -> flush compaction if suspended -> return outcome). Keep
  provider and tool adapters (real seams). Single-implementation symbol
  protocols become ordinary private methods. Absorbs the
  `managed-agent/session.ts` god-object decomposition.
- **WS5 — Recover single-consumer substrate seams.** Re-run the substrate
  deletion test, 0-production-consumer first. Shared vocabulary moves to
  `vocabulary`/`provider-core`; single-consumer implementations fold back into
  gateway internals.
- **WS6 — Compress the architecture narrative.** The main architecture doc
  keeps three things — Four owners, One execution flow, One state-authority
  table — with rings, planes, and historical decisions demoted to explanation
  and provenance. Unify the ring model, which was stated with different counts in
  `design-axioms.md` (5 rings/boundaries) and `system-architecture.md` (8): the
  two now cross-reference one canonical topology (`system-architecture.md` owns
  the complete list; `design-axioms.md` states its authority-bearing subset) and
  declare consistency, so the counts no longer read as a contradiction. The
  "Interpretation Order / narrower wins" tie-breaker is kept, not removed:
  implementation showed it serves broader tone/granularity conflicts across docs,
  not only the ring overlap. Remove stale `/sdk` references. Classify fitness
  tests (keep authority/replay/dependency; relax implementation-shape ones).

## Architectural Positions

- **One adapter is a hypothetical seam; two production adapters are a real
  seam.** Recover seams that fail this test rather than freezing a migration
  shape as permanent architecture.
- **Narrow, do not multiply.** WS3's goal is fewer total surfaces, not swapping
  one wide interface for twenty narrow writer interfaces. Group narrow ports by
  the capability a consumer actually needs; keep the count bounded.
- **Flatten, do not re-layer.** Do not replace the ops facade with a new
  abstraction. The target is fewer hops, not different hops.
- **Internal width follows authority width.** "Implementation-adjacent" is not a
  license for an indirection lattice that mirrors the whole implementation.
- **Fitness tests are the constitution's enforcement, not disposable.** Only
  relax tests that pin file layout, naming, or hotspot budgets; authority,
  replay, and package-dependency tests stay.

## Source Anchors

Gateway paths shown as `.../session/...` and `.../channels/...` are under
`packages/brewva-gateway/src/hosted/internal/` and
`packages/brewva-gateway/src/` respectively.

Verified directly:

| Path                                        | Evidence                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `.../session/runtime-ports.ts:81-88`        | `HostedRuntimeAdapterPort` exposes `runtime`, `ops`, `capabilities`, `extensions`, `createRuntime`                      |
| `.../session/runtime-ops-builders/`         | ~21 namespace builders (+ `patches`, `proposal-requests` subgroups)                                                     |
| `.../session/runtime-turn-runtime.ts:13`    | `SESSION_RUNTIMES = new WeakMap<...>`                                                                                   |
| `.../session/runtime-turn-runtime.ts:54-63` | `createRuntime?.({physics}) ?? createBrewvaRuntime(...)`, then `start()`, then `SESSION_RUNTIMES.set`                   |
| `createRuntime` callers                     | `session-runtime.ts:294`, `init/session-assembly.ts:724`, `harness/api.ts:218`, `channels/agent-runtime-manager.ts:150` |
| `HostedRuntimeAdapterPort` consumers        | brewva-cli (~16 files), gateway `channels/*` (~18), gateway `delegation/*` (~9)                                         |

From audit (per-domain Map/Tape trace; verdict TRUTH, not CACHE):

| Path                                                | Evidence                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `.../session/runtime-ops-context.ts:43`             | `HostedRuntimeOpsState` holds ~18 Map/Set fields; init empty (~`:205-224`), no tape hydration           |
| `runtime-ops-builders/workbench.ts`                 | `list()`/`commitBaseline()` read the Map directly, no tape projection                                   |
| `runtime-ops-builders/task.ts`                      | `taskSpecFor()`/blocker reads fall back to the Map when tape is empty; `taskItems` is a direct Map read |
| worker results / resource leases / context evidence | reads are direct Map reads with no tape fallback                                                        |

Substrate consumer counts (production, excluding tests and substrate self):

| Subpath                                    | Prod files | Consumers     | Note                                        |
| ------------------------------------------ | ---------- | ------------- | ------------------------------------------- |
| `agent-protocol`                           | 20         | gateway only  | single consumer, but large — defer recovery |
| `compaction`                               | 3          | gateway only  | single consumer                             |
| `context-budget`                           | 7          | gateway only  | single consumer                             |
| `persistence` / `provenance` / `execution` | 0          | none          | test-only seams — recover first             |
| `prompt`                                   | 20         | cli + gateway | real seam — keep                            |
| `session`                                  | 65         | cli + gateway | real seam — keep                            |

`./sdk` is absent from `packages/brewva-substrate/package.json` exports but is
still referenced as a concept in `system-architecture.md` (minor doc drift).

## Behavior Corrections (not surface additions)

These workstreams change observable behavior on purpose, by fixing existing
violations. They are guarded by WS0 behavior locks.

- **WS1:** session runtime lifecycle becomes single-instance; `close` ownership
  becomes well-defined. The only public runtime API change is the required
  `sessionId` parameter on the `RuntimeToolAuthorityResolver` signature
  (detailed below); no other public runtime surface changes.
- **WS2:** recoverable hosted state survives restart via tape projection instead
  of being silently lost. This restores invariant 9 (projection integrity) and
  invariant 12 (replay-derived state) in the hosted layer.

## Validation Signals

- WS0 behavior locks green and stable before any other workstream lands.
- `bun run check` and `bun test` green per workstream; `bun run test:dist`
  confirms no export/CLI/distribution drift.
- Contract tests under `test/contract/gateway` confirm no wire-protocol diff;
  existing canonical events already cover WS2 writes (assert no new event types).
- Recovery tests prove WS2 state rebuilds from tape after restart (this is the
  acceptance evidence for the correctness claim, not a LOC count).
- Count-based hosted fitness invariants: runtime-instances-per-session = 1,
  `HostedRuntimeAdapterPort` general-consumer count trends to 0, ops-facade hop
  count down. Mirrors the count-based-invariant approach in
  `rfc-tui-rendering-performance-and-test-harness.md`.

## Surface Budget

No new author-facing or authority-bearing surface is introduced. Internal
symbol counts (adapter members, builders, hops, runtime instances) decrease.

| Surface                                 | Before | After | Delta |
| --------------------------------------- | ------ | ----- | ----- |
| Required authored fields                | 0      | 0     | 0     |
| Optional authored fields                | 0      | 0     | 0     |
| Author-facing concepts                  | 0      | 0     | 0     |
| Inspect surfaces                        | 0      | 0     | 0     |
| Routing / control-plane decision points | 0      | 0     | 0     |
| Plugin / hook surfaces                  | 0      | 0     | 0     |
| Config keys                             | 0      | 0     | 0     |
| Persisted formats                       | 0      | 0     | 0     |
| Public CLI / API surfaces               | 0      | 0     | 0     |

Caveats (honest, not surface-budget categories):

- WS2 changes durability/recovery **behavior** (process-local -> tape-derived).
  It adds no persisted event type because mutations already emit events; it
  changes the read path and adds recovery hydration. This is a correction to an
  invariant violation, recorded under Behavior Corrections, not a new surface.
- WS3 narrows an internal cross-package consumption surface
  (`HostedRuntimeAdapterPort`); it is not a documented public API, so it carries
  no public-surface delta, but downstream gateway/cli imports change shape.

No positive surface deltas, so no debt owner or re-evaluation trigger is
required.

## Promotion Criteria And Destination Docs

Promote a workstream to `docs/research/decisions/` when:

- WS0 behavior locks covering its path are green;
- its change has landed with `bun run check`, `bun test`, `bun run test:dist`
  green;
- for WS2, recovery tests prove tape rebuild;
- contract tests confirm zero wire diffs;
- the resulting shape is reflected in the target architecture docs.

Record one single-decision provenance file per workstream on promotion. This
note stays active until WS1-WS4 are promoted; WS5-WS6 may promote independently.

## Concept-Surface And Governance (adjacent track, not this RFC)

The external review also flagged concept-surface and governance overload. The
substantive items are confirmed, but they belong to a separate architecture-doc
track — folding them into this RFC would defeat its own subtraction goal:

- Several axioms are corollaries of "authority and visibility are separate"
  (e.g. `same-evidence`, `product-loops-are-projections`, `doc-hierarchy`).
  Folding corollaries into parent axioms is a doc-quality change, not a hosted
  refactor.
- Once the core is declared converged, governance ceremony tuned for active
  change (Surface Budget accounting, mandatory axiom citations) can be relaxed
  toward "few and stable" decision records. This is a governance-policy change,
  owned by runtime/gateway maintainers, not by this RFC.

The ring-model unification is the one piece that legitimately overlaps this
RFC's WS6, because narrative compression is already in scope there.

## Adjacent Observations (not in scope)

- `@brewva/brewva-acp-adapter` (706 LOC, CLI-only) and
  `@brewva/brewva-capabilities` (597 LOC, gateway-only) are single-file packages
  whose split may add packaging ceremony; any merge must still satisfy the ring
  model (a split is justified only when it protects authority).
- `@brewva/brewva-vocabulary` is a 12-submodule shared-contract namespace with
  no internal layering; the dependency graph is acyclic and package count (18)
  is not itself a complexity source.

## Implementation Progress And Notes

Landed and verified (`bun run check` green + ~812-test gateway/runtime
regression green):

- **WS0** — behavior locks. Fixed worktree dependency gaps (clean 808 baseline);
  confirmed WS1's core path (`resolveHostedRuntimeTurnRuntime`, tape consistency,
  durability, approval-resume) is already locked by
  `test/unit/gateway/gateway-runtime-adapter.unit.test.ts`; added an explicit
  single-runtime invariant lock (`hosted-single-runtime-invariant.unit.test.ts`).
- **WS1** — one runtime per session lifecycle (Design A, incremental). The
  blocker turned out to be smaller than feared: `commitment.call.sessionId` and
  `input.turn.sessionId` already exist, so only the authority resolver needed a
  `sessionId` parameter — made **required**, a deliberate breaking change to the
  public `RuntimeToolAuthorityResolver` signature (the kernel always supplies it;
  recorded in the squash commit's BREAKING CHANGE footer). `createHostedRuntimeAdapter` now owns ONE stable runtime
  with router physics (provider/toolExecutor/authority resolve the session by
  sessionId from a `registerTurnSession` registry); the noop shell, the
  `createRuntime` swap side-effect, `SESSION_RUNTIMES`, and
  `cloneRuntimeConfigForHostedTurn` are gone. `createRuntime` survives only as an
  independent-runtime path for harness replay. Verified: full `bun test`
  2577 pass / 0 fail + full `bun run check` green.
- **WS2 (core domains)** — workbench, task items, and resource leases are now
  tape-authoritative (reads rebuild from tape on cache miss; Maps are droppable
  caches), fixing restart-loses-state (invariant 9/12). Pattern:
  `projectXFromTape` + `xFor` cache-on-miss, mirroring existing
  `taskSpecFor`/`taskBlockersFor`. worker-results is now tape-derived too
  (replaying record/clear semantics). context-evidence is intentionally NOT
  tape-derived: a code review flagged it as a WS2 gap, but it is by design lossy
  in-memory performance state (latest-per-kind), locked by
  `context-evidence-latest.unit.test.ts` and matching the state-taxonomy
  "performance-only state may remain local" rule — so it stays Map-only.
- **WS6** — removed the stale `/sdk` description; unified the ring model via a
  bidirectional cross-reference (system-architecture owns the canonical complete
  topology; design-axioms states its authority-bearing subset). Kept the
  Interpretation Order tie-breaker (it serves broader doc conflicts).

- **WS5 — DONE (owner chose to recover the seam).** persistence/provenance/
  execution had 0 external production consumers. This was surfaced as an
  architecture-owner decision (they were ratified public mechanism subpaths per
  `substrate-domain-slicing`, locked by `substrate-entrypoint.contract.test.ts`);
  the owner elected to apply the seam principle. The three public subpath exports
  were removed from `brewva-substrate/package.json`; the implementations stay
  substrate-internal (consumed via relative paths — `prompt/templates.ts` →
  `../provenance/source-info.js`, `tools/api.ts` re-exposes the execution
  tool-phase primitives through `./tools`). The entrypoint contract test now
  locks the absence of the three subpaths; `session-bundle` moved from a contract
  test to a unit test (it now exercises an internal mechanism via a relative
  src import, which the test policy permits only for unit tests); the
  `substrate-domain-slicing` decision doc carries a dated WS5 amendment. Re-publish
  any subpath only if a real second consumer appears.

WS3/WS4 — remaining, built on the landed WS1 single-runtime base:

WS1's earlier framing as an atomic cross-layer rewrite was wrong. The per-turn
`sessionId` is already carried on `input.turn` (provider) and `commitment.call`
(tool executor), so the shared router runtime dispatches physics by sessionId
with a required `sessionId` added to the authority resolver (a breaking
`RuntimeToolAuthorityResolver` signature change) — no runtime root change, done
incrementally and verified green.

- **WS3 — DONE.** Narrow `HostedRuntimeAdapterPort` so consumers no longer reach
  into the whole adapter. Landed in three steps:
  - `createRuntime`: removed. Only `executeHarnessCandidateComparison` consumed
    it, via the already-narrow `HarnessRuntimeFactory` (`{ runtime?: { tape },
createRuntime }`). Dropped from the adapter; the 3 call sites (cli
    `operator/harness.ts` + 2 harness tests) now build a `HarnessRuntimeFactory`
    that calls `createBrewvaRuntime` directly.
  - `capabilities`: folded. The wide adapter no longer carries a `capabilities`
    alias of `ops`. Production never read it directly — the sole bridge is
    `toToolRuntimeAdapterPort`, which maps `ops` → the tool-facing
    `capabilities`. `ToolRuntimeAdapterPort` is now defined independently (not a
    `Pick` of the wide adapter), so the tools-layer facade keeps `capabilities`.
    ~16 `test/contract/tools` + unit suites that passed the adapter directly as a
    `BrewvaToolRuntime` now go through the canonical `createBundledToolRuntime`
    bridge; the fixture-helper `capabilities` override option folded into `ops`
    (same underlying object).
  - consumer narrowing: the only cross-package consumer is the CLI (channels,
    delegation, daemon, init, host-api all construct the runtime _inside_ the
    gateway and legitimately hold the wide adapter — they are the gateway). The
    CLI funnels ops access through `runtime/cli-runtime-ports.ts`, which assembles
    two consumer-scoped aggregate ports once per session — `CliInspectPort`
    (reads) and `CliOperatorPort` (writes); the stragglers that dereferenced
    `runtime.ops` directly in app logic (entry, shell-runtime, lifecycle, report,
    questions, daemon) now consume `bundle.inspect` / `bundle.operator`. `ops` is
    now effectively gateway-private at the CLI boundary, locked by
    `test/fitness/cli-runtime-ops-seam.fitness.test.ts` (only
    `runtime/cli-runtime-ports.ts` may dereference `runtime.ops`).
  - On "make `ops` literally gateway-private": rejected as a type-level change.
    The CLI is a legitimate operator console needing broad inspect+operator
    access; removing `ops` from the exported type would force either a broad
    reader-port (no real narrowing) or twenty narrow ports — the multiplication
    this RFC explicitly forbids ("Narrow, do not multiply"). The seam-funnel +
    fitness lock delivers the intent (consumers do not reach into the wide
    facade ad-hoc) without the proliferation.
- **WS4 — DONE (turn convergence already satisfied; god object reduced).**
  - Turn-module convergence: already realized by the existing architecture. The
    canonical single turn entry is `runHostedTurnEnvelope`
    (`turn-adapter/turn-envelope.ts`); `runHostedPromptTurn` is a thin host
    convenience wrapper over it, and the rest of `turn-adapter/` is ~24 small
    cohesive files. There is no scattered or duplicated turn orchestration left
    to converge — the aspirational `HostedTurn.execute` name maps to the existing
    `runHostedTurnEnvelope` entry; a cosmetic rename was rejected as churn.
  - God-object decomposition: the clean, safe win is extracting the pure,
    `this`-free helper clusters out of `managed-agent/session.ts`
    (`session-harness-manifest.ts`, `session-prompt-dispatch.ts`); the file drops
    2034 → 1876 LOC. The remaining bulk is deliberately left in place: the ~458-
    LOC constructor is the session composition root wiring 31 interdependent
    `readonly` collaborators (the cohesive collaborators — event-bridge,
    model-selection, tool-registry, compaction flow/deferred/summary,
    phase-coordinator — were already extracted to sibling modules), and the
    compaction-orchestration methods touch ~8 session fields each. Re-expressing
    either as free functions (10-param signatures) or a collaborator that holds
    most of the session's state would add indirection without a readability gain
    and carries regression risk on the turn/compaction critical path — it would
    trade in-orchestrator cohesion for coupling-in-disguise. `session.ts` is now
    a session orchestrator/facade over already-decomposed collaborators, not an
    everything-inline god object.
  - worker-results tape-derivation already landed in WS2's review pass;
    context-evidence stays lossy in-memory by design, so WS4 no longer owns
    either.

## Related Docs

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/research/active/rfc-context-operating-system-and-compaction-physics.md`
- `docs/research/archive/rfc-effect-approval-and-rollback-closure.md`
- `docs/research/decisions/canonical-hosted-turn-envelope.md`
- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
