# RFC: Inspect, Replay, And Recovery Optimization

## Metadata

- Status: active
- Implementation state: WS0-WS3 landed with WS4 proofs in place on this branch
  (full `bun run check` green). Honest status as a discriminated union (WS0);
  shared tape grammar, non-authoritative forensic scanner, evidence-derived
  hydration/integrity projections, capability derivation, checkpoint-domain
  disambiguation (WS1); capability surfacing through the inspect report (WS2);
  the rewind/redo transaction engine — conversation and workspace rewind, redo
  with supersession (honoring an explicit redo target), per-turn auto-checkpoints,
  one transaction owner across the root CLI and interactive shell (both patch-only
  fallbacks removed), and a zero-authority engine guarantee (WS3). The engine emits
  the canonical `reasoning.revert` re-anchor plus an `ok`/`reasoningRevertEventId`
  `session.rewind.completed` receipt that the live shell and a cold hydration both
  consume, so `/rewind` moves the in-memory and the rehydrated leaf identically;
  workspace rewind fails closed on missing rollback material instead of a hollow
  success, and crash posture is visible-partial via per-patch and commit receipts
  (a distributed WAL with lease and fencing is out of scope for the single
  in-process writer). World-changing rewind invalidates verification evidence by
  construction, not by an authority-bearing event: patch-set rollback detaches
  the patch-set-keyed evidence the gate matches on (`containsAll` over
  `patchSetRefs`), so stale outcomes fall to a `stale`/`missing` posture as a
  replay-derived consequence (step 7 satisfied through steps 5-6). WS4 proofs:
  zero-cache rebuild equivalence, the rewind/redo/new-turn/rewind-again lattice
  fixture, the `brewva inspect --verify-replay` drill-down, and three standing
  fitnesses (status-evidence, engine-authority, strict/forensic grammar parity).
  Remaining: the integrity WAL/artifact/ledger dimensions (tape is verified, the
  others stay `inconclusive`); a dedicated "verification debt created by recovery"
  Work Card line (the posture data already exists); schema-evolution upcasters;
  resume-drift telemetry; and promotion of this RFC into the stable docs.
- Owner: Runtime, gateway, CLI, and operator-experience maintainers
- Last reviewed: `2026-06-17`
- Promotion target:
  - `docs/journeys/operator/inspect-replay-and-recovery.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/runtime.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/guide/cli.md`

## Problem Statement

Brewva has the right constitutional model for inspection and recovery:

`Model owns attention. Kernel owns consequence. Tape owns truth. Runtime owns physics.`

The canonical runtime records provider-independent facts such as turns, text,
reasoning, tool proposals, typed outcomes, approvals, costs, checkpoints, and
suspension causes. Kernel approval state is replay-derived, argument-bound,
first-writer-wins, lazily expired, and receipt-bearing. The Work Card already
presents a stronger operator abstraction than a raw transcript by organizing
goal, context, authority, work, evidence, and continuation around stable refs.

The operator path does not yet consistently realize that model. On current
`main`:

- hosted hydration reports `ready` with a synthetic current timestamp
- hosted integrity reports `healthy` without inspecting tape, WAL, or artifacts
- hosted rewind state is always empty, rewind always returns `no_checkpoint`,
  and redo always returns `no_redo`
- CLI undo falls back from failed lineage rewind to an independent latest-patch
  rollback, so conversation and workspace recovery have no shared transaction
  owner
- canonical startup correctly fails closed on malformed rows, while the journey
  also promises inspectable degradation; one reader cannot safely satisfy both
  authority and forensic requirements
- `checkpoint.committed` is a model materialization checkpoint, while some
  recovery prose implies a broader session-state checkpoint
- replay may fall back to hosted structured events when canonical events are
  absent, weakening the claim that raw replay and timeline share one source

These gaps are not a kernel regression. The recovery transaction owner
previously lived in the legacy runtime as `SessionRewindService`; the four-port
runtime simplification correctly removed that facade, which left the hosted
adapter with nothing to call and the operator surface stubbed to optimistic
constants. The center stayed rigorous; the surface fell back to claims it could
no longer prove. A later convergence pass — the hosted control-plane subtraction
RFC — then made hosted state tape-authoritative and narrowed the CLI ops seam,
but it deliberately did not touch these recovery stubs, so they persist on the
now-converged hosted layer. This RFC re-homes the owner into the gateway control
plane rather than restoring the removed runtime facade, and builds on that
converged layer instead of re-widening it.

The result is a rigorous center with an operator surface that can overstate its
evidence. This RFC closes that gap without widening the runtime root or
restoring the removed legacy runtime facade.

## Scope Boundaries

In scope:

- truthful hydration and integrity status
- strict authoritative replay and tolerant forensic inspection as separate read
  paths
- replay-derived recovery projections with explicit cursors and provenance
- one gateway-owned rewind/redo transaction owner
- conversation, workspace, verification, and continuation recovery semantics
- torn-tail diagnosis and explicit repair posture
- replay-equivalence and zero-cache rebuild verification
- recovery capability projection in the shared Work Card
- CLI, shell, and channel convergence on one narrow recovery port
- schema evolution rules for replay-bearing payloads
- a durable, non-authority-bearing recovery coordination receipt that outlives
  transient WAL
- standing fitness for evidence-bearing status, authority-neutral coordination,
  and strict/forensic reader-grammar parity

Out of scope:

- widening `createBrewvaRuntime(...)` beyond the four-port runtime root
- reintroducing runtime `hosted`, `operator`, `authority`, `inspect`, or private
  tape commit seams
- making DuckDB, projections, Work Cards, or recovery previews authoritative
- silently ignoring malformed middle rows in authoritative replay
- automatically rewriting event tape during startup
- generic rollback for untracked shell, network, credential, or remote effects
- cross-agent saga compensation
- promising equivalent model output across providers
- introducing a second transcript or session-state truth store

Tracked separately:

- cryptographic tape hash chaining and external signatures
- cross-agent or cross-repository recovery transactions
- remote workspace restoration
- retention policy for large rollback artifacts

## Why

Future models will improve at tool use, continuation, context management, and
cross-provider handoff. That increases the cost of ambiguous recovery. A model
may reconstruct a plan, but it cannot safely infer which effects committed,
which approval bound them, which branch is active, or whether rollback material
still exists. Those questions require runtime evidence.

Claude Code demonstrates strong product mechanics: bounded transcript writes,
resume-consistency telemetry, interruption cleanup, and file-history previews.
Pi demonstrates a clean append-only session tree, branch summaries, labels, and
explicit durable-boundary design. Brewva should learn their product discipline
without adopting transcript-as-authority.

Brewva's stronger position is that a durable session is an execution ledger:

- provider messages are materialization inputs and outputs
- canonical events record runtime facts
- receipts record authority and consequence
- WAL and snapshots provide bounded recovery material
- projections provide rebuildable views
- Work Card explains posture without becoming truth

This distinction matters only when operator surfaces are as honest as the
kernel. A false `healthy` result is worse than an explicit unavailable feature
in an evidence-first system.

### What Brewva Should Learn

From Claude Code:

- make rewind preview concrete by showing affected files and expected changes
- continuously measure resume drift even when the architecture is designed to
  prevent it
- keep rollback material bounded and avoid whole-file history as the default
  storage model

From Pi:

- preserve abandoned-branch intent through explicit summaries
- expose human-readable labels and anchors for recovery navigation
- make restore behavior a typed policy rather than hidden best effort
- treat torn final JSONL records as a distinct crash-recovery condition

These are product and operability lessons. Brewva should not copy
transcript-as-authority, provider-content-block persistence as the durable
domain model, or load-time migration without explicit authority semantics.

### What This RFC Does Not Claim

- Provider-neutral canonical events do not make model text deterministic.
- Cross-provider continuation means authority and recovery posture survive a
  provider change; it does not mean providers produce equivalent output.
- A forensic valid prefix is evidence for diagnosis, not permission to resume.
- Recovery receipts do not make arbitrary external side effects reversible.
- Event typing alone is insufficient; schema evolution and permanent replay
  fixtures are still required.

## Direction

Brewva should become an evidence-native recovery control plane over the
four-port runtime, not a chat application with generic undo.

Target operator grammar:

`inspect -> prove replay posture -> preview recovery -> apply one transaction -> verify divergence -> continue`

Target ownership:

1. Tape owns committed runtime facts.
2. Kernel owns consequence authority and receipt-limited mutation.
3. Gateway owns recovery coordination through a package-owned control-plane
   adapter.
4. CLI and channels render one shared query/command contract.
5. Forensics observes damage but never authorizes continuation.

## Architectural Positions

### Preserve The Four-Port Runtime

The public runtime remains `identity`, `config`, `tape`, `kernel`, `model`,
`start`, `turn`, and `close`. Recovery orchestration belongs in gateway
internals behind narrow ports. No private runtime assembly or tape writer is
reintroduced.

### Build On The Completed Hosted Subtraction

The hosted control-plane subtraction RFC already landed: hosted state is
tape-authoritative through `projectXFromTape` projectors, the wide
`HostedRuntimeAdapterPort` is narrowed, and CLI consumers reach recovery only
through the `CliInspectPort` (reads) and `CliOperatorPort` (writes) seam in
`cli-runtime-ports.ts`, locked by `cli-runtime-ops-seam.fitness.test.ts`. This
RFC extends that layer; it does not re-open it. The recovery projector mirrors
the established no-cache projector pattern, the recovery transaction owner is
reached through `CliOperatorPort.session`, and recovery inspection rides
`CliInspectPort.recovery`. No new wide port and no second projector store are
introduced, per "narrow, do not multiply".

### Separate Replay From Forensics

- authoritative replay is strict, canonical, and fail-closed
- forensic scanning is tolerant, issue-producing, and non-authoritative

Combining them either weakens runtime safety or makes damaged sessions
impossible to inspect.

### Make Unknown Explicit

`healthy`, `ready`, `rewindable`, and `redoable` are evidence-bearing claims.
Missing readers, unreadable artifacts, and unimplemented paths resolve to
`inconclusive` or `unavailable`, never optimistic success.

### Distinguish Checkpoint Domains

Use separate contracts for:

- model materialization checkpoints
- session fold baselines
- operator recovery checkpoints

They may reference each other but must not share an ambiguous checkpoint
identity.

### Use One Recovery Transaction Owner

Rewind and redo are coordinated operations, not CLI composition. One
gateway-owned engine owns prepare, apply, compensate, commit, reconciliation,
redo supersession, and conflict handling.

One owner does not mean one cost. Conversation-only rewind is a
compensation-free lineage fork; the compensating saga engages only when
workspace effects are in scope. The owner is also authority-neutral: it
coordinates existing receipt-bearing capabilities and emits no new
authority-bearing canonical event of its own.

### Project Capabilities, Not One Health Bit

Recovery posture is a set of evidence-derived capabilities:

- `inspectable`
- `replayable`
- `continuable`
- `rewindableConversation`
- `rewindableWorkspace`
- `rewindableBoth`
- `redoable`

Each capability carries reasons, evidence refs, and the source tape cursor.

The stable contract is the capability shape — `{ name, status, reasons,
evidenceRefs, cursor }` — not this fixed set of names. The set is open: future
capabilities such as `forkable` or `handoffable` extend it without a contract
change.

### Record Recovery History As Durable But Non-Authoritative Evidence

Recovery WAL is durable transient and clears once a transaction settles. The
fact that a session was rewound or redone — its cursor, target, mode, operator,
and one-sided divergence — must outlive that settle, or inspect cannot honestly
report what is recoverable and divergent after the WAL is gone.

This RFC therefore commits, rather than defers, a minimal durable recovery
coordination receipt: a non-authority-bearing canonical event-family carried in
the existing persisted envelope. It records which authoritative receipts a
transaction composed; it never authorizes an effect, never re-grants approval,
and is never consulted by the kernel for consequence. It is replay-derived
history, distinct from both transient WAL and authority-bearing events, and it
reuses the existing redaction layer. The minimal shape (write plus forensic
read) lands early so the engine writes it from the start; rich inspect rendering
of recovery history is a later drill-down. Choosing the durable shape now avoids
an expensive persisted-format retrofit after transactions already exist.

### Prefer Standing Fitness Over One-Time Gates

The stubs this RFC removes were not a design error; they were honest claims that
silently rotted into dishonest ones because nothing kept proving them. A
promotion gate checks a property once. The properties that matter here must hold
for every future status surface, not only the ones this RFC touches.

Three invariants therefore graduate from promotion criteria to standing,
CI-permanent fitness:

1. no evidence-bearing status (`healthy`, `ready`, `rewindable`, `redoable`, or
   any successor) is returned without evidence refs and a source cursor
2. the recovery transaction engine emits zero new authority-bearing canonical
   events
3. every byte sequence the strict reader accepts is classified healthy by the
   forensic scanner, and every sequence it rejects is localized by it

These run against present and future code, so the next optimistic stub fails the
build instead of shipping. All three are authority/replay-correctness fitnesses,
so they sit in the kept tier of the hosted-subtraction RFC's fitness
classification (authority/replay/dependency kept; implementation-shape relaxed),
not the relaxed tier.

## Source Anchors

Stable Brewva docs:

- `docs/architecture/design-axioms.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/journeys/operator/inspect-replay-and-recovery.md`
- `docs/reference/runtime.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/working-projection.md`

Current implementation:

- `packages/brewva-runtime/src/runtime/runtime.ts` (four-port root, unchanged)
- `packages/brewva-runtime/src/runtime/tape/impl.ts` (checkpoint+delta
  `replayBaseline`; strict reader only, no forensic mode yet)
- `packages/brewva-runtime/src/runtime/kernel/impl.ts`
- `packages/brewva-runtime/src/runtime/model/impl.ts`
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ports.ts`
  (`HostedRuntimeAdapterPort` narrowed: `createRuntime` removed, `capabilities`
  folded; `ops` is gateway-private)
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/session.ts`
  (the synthetic hydration/integrity/rewind/redo stubs to replace, `:53-182`)
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/runtime-ops-projections.ts`
  (the established `projectXFromTape` no-cache projector pattern to mirror)
- `packages/brewva-cli/src/runtime/cli-runtime-ports.ts`
  (`CliInspectPort.recovery` / `CliOperatorPort.session` — the seam recovery extends)
- `test/fitness/cli-runtime-ops-seam.fitness.test.ts`
  (only `cli-runtime-ports.ts` may dereference `runtime.ops`)
- `packages/brewva-cli/src/operator/inspect/report.ts`
- `packages/brewva-cli/src/operator/inspect/work-card.ts`
- `packages/brewva-cli/src/entry/main.ts` (the two-plane undo fallback, `:550-607`)

Decision history:

- `docs/research/archive/rfc-hosted-implementation-subtraction-and-ops-facade-collapse.md`
  (landed WS0-WS6: single runtime, tape-authoritative hosted state, narrow CLI
  seam — the layer this RFC builds on)
- `docs/research/decisions/session-rewind-as-conversation-fork-primitive.md`
- `docs/research/decisions/event-stream-consistency-and-replay-fidelity.md`
- `docs/research/decisions/recovery-robustness-under-interrupt-conditions.md`
- `docs/research/decisions/four-port-runtime-simplification-rfc.md`

External comparisons:

- `/Users/bytedance/new_py/claude-code/src/utils/sessionStorage.ts`
- `/Users/bytedance/new_py/claude-code/src/utils/fileHistory.ts`
- `/Users/bytedance/new_py/claude-code/src/utils/conversationRecovery.ts`
- `/Users/bytedance/new_py/pi-mono/packages/coding-agent/docs/sessions.md`
- `/Users/bytedance/new_py/pi-mono/packages/coding-agent/docs/compaction.md`
- `/Users/bytedance/new_py/pi-mono/packages/agent/docs/durable-harness.md`

## How

### 1. Recovery Projection

Add a pure recovery projector alongside the existing hosted projectors
(`runtime-ops-projections.ts`), in the gateway control-plane boundary. Input is
canonical events plus explicitly classified recovery artifacts. Output is
immutable and cursor-bound:

- hydration status and fold issues
- integrity issues grouped by tape, WAL, artifact, ledger, and projection
- active lineage, abandoned branches, and recovery targets
- patch windows and rollback-material availability
- open turns, open tool commitments, and unclean shutdown posture
- redo stack derived from durable recovery outcomes
- recovery capabilities and canonical evidence refs

Mirror the established no-cache projector pattern (`createHostedProjections` /
`projectXFromTape` in `runtime-ops-projections.ts`): every read replays tape, so
the projection can never disagree with durable truth. Add a cache only if
profiling shows inspect is hot, and then only as a droppable, cursor-bound cache
that rebuilds to the same normalized projection.

### 2. Two Tape Read Modes

Keep the runtime reader strict. Add a forensic scanner outside runtime
authority that reports file, byte offset, line, last valid event id, issue
class, and whether damage is tail-local or precedes later records.

Both readers import one canonical record grammar so they cannot drift into two
definitions of a well-formed record. The strict reader's accepted set stays a
subset of what the forensic scanner classifies as healthy, and anything the
strict reader rejects the scanner must localize. The readers differ in posture,
not in their definition of a record.

A torn final line is diagnosable when the final non-empty record is incomplete
and no later bytes exist. It is not silently truncated. Inspect may recommend a
repair plan that backs up the original tape and truncates to the last valid byte
offset, but repair requires explicit operator action. Malformed middle rows are
never skipped for authoritative recovery.

### 3. Truthful Status Before Rich Recovery

Replace optimistic stubs first:

- hydration without a projector becomes `unavailable`
- integrity without completed checks becomes `inconclusive`
- rewind and redo report capability-specific unavailability
- Work Card names the missing evidence and owning subsystem

This is the first correctness gate.

### 4. One Rewind/Redo Transaction Engine

The engine lives in gateway internals and is reached through the established
`CliOperatorPort.session` write seam (and surfaced through
`CliInspectPort.recovery`), not a new wide port. It distinguishes two cost
classes so the common path stays cheap:

- conversation-only rewind is a degenerate, compensation-free fork: it moves the
  active reasoning lineage append-only and reverses nothing, because no world
  effect is mutated. No WAL prepare and no patch rollback are required.
- workspace and `both` rewind are compensating transactions: they mutate tracked
  files and therefore require WAL prepare, reverse rollback, and compensation.

One owner spans both classes; the saga machinery engages only when workspace
effects are in scope.

Rewind (workspace and `both`; conversation-only skips steps 4-5):

1. derive a side-effect-free plan
2. validate target, patch window, artifacts, capability, and idle posture
3. acquire a per-session lease with fencing token
4. persist Recovery WAL `prepared` state before mutation
5. roll back patch sets in reverse order through receipt-bearing capabilities
6. move active lineage when conversation recovery is selected
7. invalidate verification evidence whose world assumptions changed
8. record continuation summary and explicit one-sided divergence
9. write a durable, non-authority-bearing recovery coordination receipt linked
   to the authoritative receipts it composed
10. settle the WAL record

Failure compensates in reverse order where effects are compensatable. Partial
failure remains visible and blocks automatic continuation.

Redo applies the exact recorded window and never reconstructs state by
inference: it replays the recorded window or fails closed. Divergent mutation or
a new checkpoint supersedes incompatible redo entries. The redo stack is a
projection derived from durable recovery coordination receipts, not a separate
mutable store.

Coordination stays compositional and authority-neutral: patch authority stays in
kernel/tool receipts, lineage stays replay-derived, verification invalidation is
explicit, and WAL remains durable transient. The engine emits no new
authority-bearing canonical event; every workspace or lineage mutation flows
through an existing receipt-bearing capability. The only durable record it owns
is the non-authority-bearing coordination receipt, which records what was
composed but authorizes nothing and must not be smuggled into advisory `custom`
authority.

### 5. Work Card Recovery Contract

Extend the shared Work Card instead of creating another dashboard. Expose:

- tape cursor and projection freshness
- hydration and integrity posture
- recovery capabilities and denial reasons
- selected target and patch-window summary
- expected workspace changes before apply
- conversation/workspace divergence
- verification debt created by recovery
- last transaction and evidence refs
- recommended next operator action

Raw replay, forensic issues, timeline, and file diff remain explicit
drill-downs.

### 6. Replay Equivalence Verification

Add `brewva inspect --verify-replay --session <id>` as a forensic drill-down.
Compare a fresh zero-cache projection rebuilt from canonical tape against the
persisted or served rebuildable projection.

Use normalized per-view hashes excluding display clocks, temporary paths, and
process-local diagnostics. Report the first divergent view and source refs
rather than one opaque pass/fail.

CI adds a "torch the caches" suite: delete rebuildable projection/index
artifacts, reconstruct them, and compare normalized results. Property tests
cover valid event sequences, checkpoint placement, projection deletion,
interrupted turns, and WAL states.

### 7. Provider Portability And Schema Evolution

Cross-provider validation proves authority and recovery projections are
provider-independent, materialization produces a valid target-provider
request, and continuation does not re-authorize prior effects. It does not
assert equivalent model text.

Long-lived tape also needs explicit evolution:

- envelope or event-family payload versions
- pure upcasters for supported historical versions
- no lossy migration of authority-bearing fields
- unknown authority-bearing versions fail closed
- forensic inspection may report unsupported rows without authorizing them
- historical migration fixtures remain permanently replayable

Automatic migration is not inherently weak. Silent, unversioned, or lossy
migration is the prohibited behavior.

## Workstreams

### WS0: Truthful Status

- remove synthetic `ready` and `healthy` responses
- characterize CLI, shell, and channel output before changing contracts
- mark unimplemented recovery capabilities as unavailable
- correct journey wording where it currently describes target behavior as
  implemented behavior
- lock the new honest hydration, integrity, rewind, and redo outputs with
  contract/snapshot tests so they cannot silently revert to optimism
- install the first standing fitness: no evidence-bearing status without
  evidence refs and a source cursor

This workstream is intentionally first. A rigorous system must stop overstating
evidence before it adds richer controls.

### WS1: Forensics And Projection

- implement non-authoritative forensic scanning
- import one shared canonical record grammar across the strict and forensic
  readers
- mirror the established `projectXFromTape` no-cache projector for hydration and
  integrity folds
- add cursor-bound provenance and capability derivation
- define checkpoint domains and recovery target identity
- define the durable non-authority-bearing recovery coordination receipt shape
  and its forensic read path
- verify projection deletion and rebuild behavior

### WS2: Preview And Shared Surface

- compute active targets, abandoned targets, patch windows, and redo posture
- render recovery, expected file changes, and divergence through Work Card
  drill-downs
- extend the established `CliInspectPort`/`CliOperatorPort` seam; converge shell
  and channel onto it rather than adding a parallel port
- expose labels and summaries without making them authority

### WS3: Transactional Rewind And Redo

- model workspace rewind as a single-writer, visible-partial transaction:
  ordered per-patch and commit receipts, compensation, and supersession, failing
  closed on missing rollback material (no distributed WAL or fencing — the hosted
  adapter is the sole in-process writer; the daemon control plane owns the
  durable-transient Recovery WAL for channel sessions)
- model conversation-only rewind as a compensation-free lineage fork
- remove the independent CLI patch-only undo fallback (`entry/main.ts:550-607`,
  now composed through `operator.session.rewind` + `operator.tools.rollbackLastPatchSet`)
- preserve explicit partial-failure and irreversibility posture
- invalidate verification evidence after world-changing recovery
- require the exact recorded window for redo
- write the durable coordination receipt on settle and derive the redo stack
  from it
- assert the engine emits no new authority-bearing canonical event

### WS4: Proof And Promotion

- add replay verification and zero-cache tests
- add migration and cross-provider fixtures
- add a permanent rewind/redo/new-turn/rewind-again lattice property fixture
- add resume-drift telemetry as a production signal
- update stable docs and remove stale implementation claims
- freeze one recovery port and one shared projection
- freeze the three standing fitness invariants as CI-permanent checks

## Failure Semantics

- unreadable canonical tape: authoritative replay unavailable; forensic inspect
  may report a valid prefix
- torn final line: explicit repair plan, never automatic startup mutation
- malformed middle row: no authoritative continuation
- Recovery WAL corruption (daemon control plane): channel mutation fails closed
  while inspect remains available
- missing projection: rebuild and compare from tape
- missing rollback material: workspace rewind unavailable; conversation rewind
  may remain available
- failed compensation: transaction is partial and continuation blocks
- single in-process writer: no fencing token — rewind and turns are sequential
  in the hosted adapter, so there is no concurrent writer to reject
- unknown schema version: forensic visibility only
- settled Recovery WAL (daemon control plane): channel transaction history
  remains readable through the durable coordination receipt, not the cleared WAL

## Validation Signals

- no `healthy` or `ready` claim lacks evidence refs and a source cursor
- strict runtime replay continues rejecting malformed authority rows
- forensic scanning reports damage without supplying resumable state
- zero-cache rebuild equals normalized persisted projection
- deleting projection and DuckDB artifacts does not change recovery outcomes
- WAL corruption blocks mutation and remains visible
- active lineage excludes abandoned-branch patch sets
- partial rollback compensates or reports an explicit partial result
- one-sided rewind creates typed divergence
- redo reuses the exact window and obeys supersession
- CLI, shell, and channel return the same capability posture
- provider portability preserves authority without asserting text equivalence
- the recovery transaction engine emits zero new authority-bearing canonical
  events; every workspace or lineage mutation flows through an existing
  receipt-bearing capability
- conversation-only rewind performs no compensation and writes no patch rollback
- strict and forensic readers share one canonical record grammar; strict accept
  implies forensic healthy and strict reject implies forensic localization
- a settled recovery transaction leaves a durable non-authority-bearing
  coordination receipt that inspect can read after the WAL clears, and replay
  and kernel consequence are identical with that receipt absent
- redo replays the exact recorded window or fails closed, never reconstructing
  state by inference, across the rewind/redo/new-turn/rewind-again lattice
- the three standing fitness invariants run in CI against present and future
  code, not only at promotion
- recovery additions respect the `cli-runtime-ops-seam` fitness: only
  `cli-runtime-ports.ts` dereferences `runtime.ops`; CLI, shell, and channel
  reach recovery through `CliInspectPort.recovery` / `CliOperatorPort.session`
- the recovery projector follows the no-cache `projectXFromTape` pattern (or, if
  cached, a droppable cursor-bound cache that rebuilds identically)
- implementation work passes `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`
- CLI/export changes also pass `bun run test:dist`

## Promotion Criteria

Promote when:

1. optimistic hydration, integrity, rewind, and redo stubs are gone
2. stable docs distinguish replay from forensics
3. hydration and integrity are replay-derived and cursor-bound
4. one engine owns rewind and redo across product surfaces
5. capability, preview, and divergence appear through the shared Work Card
6. zero-cache verification, schema evolution, and torn-tail policies are tested
7. stable docs and current code describe the same recovery system
8. recovery history survives WAL settle through the durable coordination receipt,
   which authorizes nothing
9. the three standing fitness invariants run in CI against present and future
   code

## Alternatives Considered

- **Restore the legacy runtime rewind service:** rejected because its useful
  transaction semantics do not justify restoring the removed runtime facade.
- **Keep CLI composition:** rejected because independent lineage and patch
  operations cannot provide compensation, exact redo, or honest partial state.
- **Make tape parsing tolerant everywhere:** rejected because skipping
  authority rows may authorize a state that never existed.
- **Use projection or DuckDB as recovery authority:** rejected because both are
  rebuildable query surfaces.
- **Copy transcript-tree persistence from another agent:** rejected because it
  would collapse provider materialization and runtime consequence into one
  long-lived schema.

## Risks

- The engine can become a god object or, worse, a second authority source. Keep
  projection, scanning, transaction, and rendering as separate units behind one
  bounded product port, and assert it emits no new authority-bearing event.
- The strict and forensic readers can drift into two definitions of a valid
  record. Bind them to one shared grammar and a subset fitness.
- The durable coordination receipt can be mistaken for authority. It records
  what was composed and authorizes nothing; replay and kernel consequence must
  be identical with it absent.
- Compensation cannot reverse arbitrary external effects. Capabilities must
  report irreversibility.
- Replay proof can become self-validating. One side must rebuild from raw tape
  with caches disabled.
- Upcasters can hide semantic drift. Authority migrations require permanent
  fixtures and losslessness review.
- Provenance can expose secrets. Reuse redaction and show refs before payloads.

## Surface Budget

Counts are scoped to this RFC.

| Surface                               | Before | After | Delta |
| ------------------------------------- | ------ | ----- | ----- |
| Required authored fields              | 0      | 0     | 0     |
| Optional authored fields              | 0      | 0     | 0     |
| Author-facing concepts                | 0      | 0     | 0     |
| Default inspect surfaces              | 1      | 1     | 0     |
| Explicit inspect/replay drill-downs   | 3      | 4     | +1    |
| Recovery command owners               | 2      | 1     | -1    |
| Routing/control-plane decision points | 2      | 1     | -1    |
| Plugin or hook surfaces               | 0      | 0     | 0     |
| Config keys                           | 0      | 0     | 0     |
| Canonical persisted envelope formats  | 1      | 1     | 0     |
| Public runtime root members           | 8      | 8     | 0     |
| Public CLI flags                      | 5      | 6     | +1    |

The positive delta is the explicit `--verify-replay` drill-down. It adds no
authority and does not change the default Work Card surface. Runtime, gateway,
and operator-experience maintainers must review it before promotion.

This revision also commits one new non-authority-bearing canonical event-family,
the recovery coordination receipt, inside the existing persisted envelope, so the
envelope-format count stays 1. It is the previously-deferred separate
persisted-format decision, now made in minimal form rather than left open,
because retrofitting a durable shape after transactions already exist is more
expensive than committing it up front. It adds no authored surface and no kernel
authority. It is also the one deliberate exception to the hosted-subtraction
RFC's "assert no new event types" signal, which scoped that assertion to WS2
hosted-state reads; recovery coordination history is a distinct, justified new
non-authority event-family, not a hosted-state read.

## Desired Product Statement

> A Brewva session is a replayable execution ledger. Inspect shows what is
> known, unknown, authorized, committed, recoverable, and divergent. Recovery
> changes the world only through explicit capabilities and receipt-linked
> transactions.
