# RFC: Coupled World Rewind, Delegation Changeset Physics, Reversibility Tiers, And The Supervision Surface

## Metadata

- Status: active
- Implementation state: Phase 1 landed (world store + checkpoint capture,
  `worlds.enabled` now defaulting on — see the flip note below) with an
  eight-angle review round applied. Deltas from this
  note discovered in implementation: the config namespace is top-level `worlds`
  (matching the `tape`/`ledger`/`projection` grammar, not
  `workspace.worldSnapshots`); capture is unconditional with content-address
  dedup instead of mutation-gated (an exec-free oracle cannot see external
  editors, so the stat scan IS the minimal honest look); capture runs at every
  rewind checkpoint — which the hosted evidence stream records once per
  provider ROUND, so the clean path was engineered to zero writes (dirty-flag
  stat cache with a racy-clean watermark, refs record world transitions only,
  trim-triggered + time-throttled sweep, inflight markers so sweep can never
  race a capture); the block contract (`brewva.world.v1` schema + minimal
  parse) lives in `@brewva/brewva-vocabulary/session` beside the checkpoint
  event type; enumeration hard-excludes `.git`/`.brewva`/`.orchestrator` plus
  the resolved store dir on both backends and fail-closes on size caps; the
  preview's world availability is manifest-shallow (the cockpit-sync hot path),
  with deep blob verification reserved for the restore preflight; channel-agent
  runtimes namespace `worlds.dir` like every other durable store; and the
  dynamic real-tape liveness fitness gained a live-generated worlds-enabled
  assertion (default-off lanes cannot ride the frozen fixture). Phase 2 landed:
  `materialize` (fully preflighted fail-closed — missing blobs or a non-file
  occupant abort before any mutation; deletes before writes; content-equal
  files cost a stat-cache hit and only reconcile their exec bit), the engine's
  world-first workspace restore (pre-restore capture as a new edge, window
  patches marked rolled back under the patch executor's own receipt spelling
  with `method: "world_restore"`, patch lane as fallback for non-mutating
  preflight failures only, mid-flight errors fail closed with no fallback),
  preview `ready` honoring the world lane, and a `worldRestore` block on the
  completion receipt and result. Measured on this 2,546-file / 21 MB repo
  (Darwin/APFS): cold capture 2.47 s (once per workspace), warm clean capture
  p50 ≈ 135 ms, no-op restore 128 ms — within the validation gates, so the
  cost matches Shepherd's own ~2-3%-of-a-turn claim. The default was flipped to
  `true` after the measurements landed — the world-restore lane is the point of
  the feature, and enabling it broke exactly one test (a disabled-path
  assertion that had relied on the default), which now opts out explicitly; the
  feared platform-dependent test suite did not materialize (a temp-dir capture
  is deterministically walk-backed, and every integration test tolerates the
  extra checkpoint block). The integrity `artifact` dimension stays with the
  inspect-replay RFC's WS1 residue where WAL/ledger/artifact land together
  against one evidence shape. The Phase 2 review round (four adversarial
  angles) then hardened the lane: a store-held restore guard spans the
  verify→pre-capture→materialize composite (the pre-capture's own
  trim-triggered sweep could otherwise deterministically collect a target
  world whose ref fell out of retention); restore deletes only files whose
  bytes the store has seen (scope drift spares unknown data, `sparedFileCount`
  says so); every mutation target preflights realpath containment and
  directory ancestry (symlinked-ancestor escapes and ENOTDIR occupants fail
  closed before a byte moves); only exec bits are reconciled relative to the
  file's current mode (no permission widening, setuid survives); emptied
  directories prune like git checkout; window patches are superseded only
  when every applied path is restore-governed (out-of-scope survivors stay
  patch-lane reachable and are named on the world-level completion receipt,
  which also keeps tree-mutation folds honest for empty-window restores);
  a code-only rewind no longer advances the conversation redo boundary; the
  stat cache deletes now survive the merge-on-save; and the CLI copy names
  the lane and the partial-restore posture instead of "reverted 0 patch
  set(s)". Phase 3 landed as an upgrade of the EXISTING delegation fork (the
  effectful `mkdtemp`+FICLONE isolation already ran for `patch-snapshot`;
  what was missing was settlement physics): the fork is now git-SCOPE copied
  (tracked+untracked-unignored plus a real `.git` directory — a linked
  worktree's pointer file is deliberately not cloned so worker git commands
  can never reach the parent's shared index/HEAD; tracked symlinks and
  submodule trees keep whole-tree parity; the fork starts with a fresh
  `.brewva`), the fork is captured into the parent's world store right after
  copy (`basisWorldId` = exactly what the worker saw; a failed basis capture
  fails the fork closed), sealing diffs the basis and result manifests by
  content (the size+mtime baseline diff and its racy-clean misses are
  subtracted; an enumeration-backend flip mid-run fails the seal closed;
  seal failures now fail the run loudly instead of reporting a completed run
  with silently dropped edits), every change's `beforeHash` is basis content,
  and `worker_results_apply` gained a per-path settlement gate —
  fast-forward or no-op per path, `basis_conflict` fail-closed on parent
  divergence with durable `apply_failed` receipts, which is strictly finer
  than Shepherd's whole-changeset path-disjoint refusal. Non-UTF-8 artifacts
  are refused honestly instead of being corrupted by the utf8 round-trip;
  the unreachable rename intent lane was subtracted; and delegation runs
  release their store refs on fork disposal (adoption reads artifacts, never
  the store, so the worlds are telemetry with a bounded life). Phase 4 landed
  as the honest COVERED-minus-residue outcome: brewva already has a RICHER
  reversibility model than Shepherd's three tiers — `EffectRecoverability`
  (`observe_only | reversible | compensatable | manual_recovery |
irreversible`), derived from effect classes + recovery policy and already
  surfaced to the model via the capability view — and it is already a pure
  view that no admission path reads. So Loop 3's proposed enum is not built
  (that would duplicate); the genuine residue was three narrow gaps the RFC
  itself named: the operator's approval card DROPPED the tier (it was on the
  tape at `authority.manifestBasis.commitmentPosture.recoverability`, the
  read-model just never read it), the world lane was not reflected at the
  approval point, and no fitness pinned the non-authority invariant. Phase 4
  lifts the tier onto the `PendingEffectCommitmentRequest` card, adds a coarse
  `workspaceRewindable` advisory (a `workspace_write`/`local_exec` effect is
  workspace-restorable via `/rewind code` when the world lane covers the turn,
  even when its per-effect tier is `manual_recovery` — the one new truth
  Phase 2 created, surfaced orthogonally rather than by corrupting the enum
  since world restore is whole-workspace, not exact per-effect reversal),
  renders both on the operator ask line, and adds a standing fitness that
  scans the whole kernel admission surface (dynamically, not a hardcoded
  allowlist) for any recoverability-literal comparison or `.recoverability`
  read — axiom 19 turning documented negative space into an enforced
  contract. `compensable` as a reserved authoring slot is moot: `compensatable`
  already exists and is already derived. The rewind-preview half of Loop 3 was
  already delivered by Phase 2's `world` availability field. Phase 5 (Loop 4,
  the supervision surface) resolved to a documented **NO-GO / DEFER** at its
  gate rather than a build — the honest outcome of the RFC's own "separate
  go/no-go". Readiness map: of the four verbs, **observe** and **discard** are
  already near-free (cross-session `listEvents`/`sessionIds` and the
  session-index read any id with no owner guard; `executeRewind(ctx, sessionId,
  input)` already drives an arbitrary session for a non-owner caller — an
  operator path passes a foreign target id today), **inject** needs a new
  managed-tool write path plus a consume-side liveness route (the durable
  steering inbox is owner-keyed and its in-memory projection is load-once
  authoritative, so a foreign append is not observed by a live child), and
  **handoff** needs genuine new fork machinery (no durable mid-run
  cross-session fork exists — `parentId` is a same-session branch hook the
  tree-history decision defers to the inspect-replay RFC; sub-agents get
  fresh-session-plus-`parentSessionId` lineage, not a leaf fork). The surface
  is constitutionally buildable (opt-in control-plane; single-writer preserved
  because every write flows through the one in-process hosted writer; each verb
  is a single tool call) — but the **decisive fact is that no consumer exists**:
  no model-driven meta-agent role, tool, eval, or test would call it, and the
  only cross-session control today is the daemon's OS-process `SessionSupervisor`
  (`steerSession`/`abortSession`) and the delegation orchestrator's
  `cancel`/`subagent_status` — infra parent→child, not a session-over-peer
  model tool. Shipping it now would be an organ without circulation, exactly the
  dead surface `critical-rules.md` forbids and axiom 17 defers. **Flip
  condition**: a concrete model-driven supervisor consumer on the roadmap (a
  `supervisor`/`meta-agent` delegation archetype, or an eval like CooperBench's
  runtime-intervention loop). When that lands, build the two free verbs first
  (observe + discard) behind an opt-in capsule with a liveness fitness, then
  inject, and treat handoff's cross-session leaf fork as a joint item with the
  inspect-replay RFC. Until then Loop 4 stays specified-not-built, and it can be
  split into its own note or archived without touching Loops 1–3. A whole-branch
  holistic review round (two cross-phase angles, after the five per-phase
  rounds) then drove a consolidation the incremental reviews could not see. Its
  central finding: the delegation fork's world store had been pointed at the
  PARENT's `.brewva/worlds` (Phase 3), which — because a delegation fork
  enumerates the fork tmpdir while the checkpoint lane enumerates the real tree
  — shared ONE stat cache keyed by workspace-relative path across two different
  roots, shared the GC lock, bloated the parent store with transient fork
  blobs, AND ran unconditionally on `boundary === "effectful"` with no
  `worlds.enabled` gate (so effectful delegation wrote `.brewva/worlds` in the
  default disabled deployment). The fix is a single refactor: the fork store is
  now FORK-LOCAL and ephemeral (rooted at `tempRoot/worlds`, a sibling of the
  captured copy, disposed whole with the tmpdir), which removes every
  shared-state hazard, the enable-gate divergence, the `releaseSession` API
  (delegation was its only consumer), and the vestigial
  `PatchSet.basisWorldId/resultWorldId` provenance (no consumer after seal; the
  per-change `beforeHash` carries the basis) in one move. FICLONE was verified
  NOT to preserve mtime on this platform, so the shared cache was a thrash /
  soundness issue rather than a live corruption — the fork-local store moots it
  either way. The same round consolidated the two `git ls-files` sites and their
  divergent runtime-data-root exclusion vocabularies into one exported
  `listGitScopedPaths` + `RUNTIME_DATA_ROOT_NAMES`, and made the rewind
  executor reuse the preview's `projectWorldAvailability` predicate instead of
  re-inlining it. Deliberately NOT changed (both review angles agreed these are
  sound scoping, not defects): the coupling is an ordered emit sequence, not
  Shepherd's single atomic op — accepted as the substrate's documented
  crash-safe-not-power-safe / visible-partial posture (a hard kill between the
  world materialize and the completion receipt is recoverable via the durable
  `fromWorldId` on the started receipt, and a distributed WAL is out of scope);
  the settlement verb set (apply+reject, with select+apply merged into the finer
  per-path gate) is a defensible subset of Shepherd's select/apply/release/
  discard for a run-to-completion worker model; and the byte-identical-replay →
  KV-cache-reuse claim is a structural property of the pre-existing tape tree
  this branch did not touch — a prefix-stability regression guard across a
  rewind boundary is a noted cheap follow-up, not a gap this branch introduced
- Owner: Runtime, gateway, and tools maintainers
- Last reviewed: `2026-07-08`
- Depends on:
  - [RFC: Inspect, Replay, And Recovery Optimization](./rfc-inspect-replay-and-recovery-optimization.md)
    (the rewind/redo transaction engine this RFC extends with a world lane)
- Promotion target:
  - `docs/reference/runtime.md`
  - `docs/reference/proposal-boundary.md`
  - `docs/journeys/operator/approval-and-rollback.md`
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/architecture/system-architecture.md`

## Problem Statement

Brewva's reversibility story is split across three mechanisms that do not
compose:

- the **tape tree** (`CanonicalEvent.parentId`, leaf-tracked in
  `packages/brewva-runtime/src/runtime/tape/impl.ts`) is the conversation-axis
  truth: any committed event can parent a new branch, prefixes are preserved
  byte-identically, and the rewind/redo transaction engine
  (`packages/brewva-gateway/src/hosted/internal/session/recovery/rewind-engine.ts`)
  re-anchors reasoning with receipts;
- the **patch lifecycle** (`packages/brewva-tools/src/patch-lifecycle/rollback.ts`)
  is the only real file-axis rewind: copy-on-write `before/` captures plus a
  `rollback.json` manifest, unwound newest-first, fail-closed on missing
  artifacts — but it covers **only mutations made through the tracked write
  tool** (`packages/brewva-tools/src/families/navigation/source-patch.ts`);
  anything a shell command writes during `exec` is outside the promise;
- the **box snapshot plane** (`packages/brewva-tools/src/internal/box/boxlite/plane.ts`)
  captures a qcow2 layer before every workspace-write exec, yet its
  `restore`/`fork` contract (`packages/brewva-tools/src/internal/box/contract.ts`)
  has zero product callers, and the workspace is bind-mounted to the host, so
  the guest disk snapshot never contained the workspace at all.

Three consequences follow. `/rewind code|both` silently under-promises: a turn
whose damage came from `exec` cannot be rolled back, and one missing rollback
artifact fails the whole window. The delegation vocabulary declares a
`patch-snapshot` archetype — "effectful, copy-on-write snapshot workspace"
(`packages/brewva-vocabulary/src/internal/delegation.ts`) — but
`isolationStrategy: "snapshot"` is carried as metadata through
`packages/brewva-gateway/src/delegation/execution-plan.ts` and materialized by
nothing: a worker edits the shared workspace directly, which is exactly the
"documented invariant that nothing checks" axiom 19 names. And the approval
surface cannot tell the operator which commitments are reversible: approval
gates whether an effect may happen (`docs/reference/proposal-boundary.md`),
while nothing states whether it can be undone afterwards.

The peer study behind this note examined Shepherd (arXiv 2605.10913,
"Programmable Meta-Agents via Reversible Agentic Execution Traces", repo at
`/Users/bytedance/new_py/shepherd`), whose core claim is the **atomic coupled
fork**: agent state and environment state fork and restore together. The honest
comparative finding: on the conversation axis Brewva is already stronger —
Shepherd has no durable mid-run fork (its runtime checkpoint is in-memory
stream truncation; its supervision experiments restart the worker session and
lose its memory), while the tape tree branches at any committed event. On the
**environment axis** Shepherd is stronger: worlds are content-addressed git
trees, live forks are copy-on-write carriers (APFS clonefile on macOS), and
nothing touches the base workspace until an explicit settlement verb. This RFC
takes that residue and nothing else.

## Scope Boundaries

In scope:

- a durable **world snapshot** captured at the checkpoint boundary and a
  world-restore lane inside the existing rewind transaction engine, with the
  patch-unwind lane retained as fallback and preview comparator
- **changeset physics** for the already-declared `patch-snapshot` delegation
  archetype: fork a live world for the worker, seal its delta as the `PatchSet`
  the adoption contract already expects, settle with explicit verbs
- a derived **reversibility tier** on effect commitments, projected into
  approval and rewind preview surfaces — views only, never a gate
- an opt-in, control-plane **supervision surface** that exposes Brewva's
  existing primitives (steering append, leaf fork, rewind) to a supervisor
  session as managed tools

Out of scope (owned elsewhere; this RFC must not re-open):

- adopting Shepherd as a runtime dependency → rejected below (Peer Lens); this
  RFC borrows its model, not its process
- replacing or wrapping the canonical tape, the recovery WAL, or single-writer
  replay authority → the tape stays commitment memory (axioms 5, 6); the
  deliberate single-writer end-state is
  [tree-history-and-multi-writer-substrate](../decisions/tree-history-and-multi-writer-substrate.md)
- content-level merge at settlement → adoption stays fast-forward or
  path-disjoint, fail-closed; conflict resolution is model-native recovery
  (axiom 10), never kernel synthesis
- OS-level syscall enforcement (Seatbelt/Landlock) → a real gap, but a separate
  security topic with its own review; nothing here widens or narrows
  `boundaryPolicy`
- provider KV-cache work → byte-identical prefix preservation already falls out
  of the tape tree; cache policy stays gateway-owned

## Peer Lens: What Shepherd Actually Provides

Verdict vocabulary: **COVERED**, **REJECT**, **BORROW**, **OUT OF SCOPE**.

| Shepherd mechanism                                                                  | Verdict      | Rationale / where it lands                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect stream with intent/outcome separation                                        | COVERED      | `tool.proposed` → `tool.started` → `tool.committed`/`tool.aborted` plus `approval.requested`/`approval.decided` already split intent from outcome with receipts.        |
| Git-like persistent execution trace, every state reachable                          | COVERED      | Append-only tape + `parentId` tree; a branch is a new edge, never a rewrite. Single-writer by decision, not by gap.                                                     |
| Byte-identical replay reaching the provider prompt cache (~95% hit)                 | COVERED      | Tape-tree rewind preserves the message prefix by construction; cache policy is already gateway-owned.                                                                   |
| In-process scope checkpoint (effect-stream truncation)                              | REJECT       | Strictly weaker than the durable tape leaf; volatile across crashes. Nothing to borrow.                                                                                 |
| Worlds as content-addressed git trees; parent advances only on settlement           | BORROW       | Loop 1's durable world store and Loop 2's seal step. The strongest idea in the repo.                                                                                    |
| Copy-on-write live carriers (APFS clonefile on macOS; copy floor elsewhere)         | BORROW       | Loop 2's worker fork. Flat per-fork clones, so no analogue of the qcow2 ~8-layer / overlay ~60-layer chain-depth ceilings.                                              |
| Settlement verbs: `select` (ff-only), `apply` (path-disjoint), `release`, `discard` | BORROW       | Loop 2 maps them onto the existing worker adoption dispositions; the fail-closed no-synthesis discipline matches the proposal boundary's posture.                       |
| Reversibility tiers: reversible / compensable / irreversible per effect             | BORROW       | Loop 3, as derived vocabulary + projection. Shepherd authors tiers; Brewva derives them from lane coverage (axiom 18 keeps them view-only).                             |
| Runtime supervision verbs (inject / handoff / discard over worker harnesses)        | BORROW shape | Loop 4. Brewva's primitives are already stronger: steering inbox = inject; tape-leaf fork = handoff **without** memory loss; coupled rewind = discard.                  |
| Signature-is-the-permission-surface (`May[GitRepo, ReadWrite]` grants)              | OUT OF SCOPE | Brewva's authority model is effect classes + approval + boundary policy, not authored task signatures. A different authoring model, not a gap.                          |
| Lean-mechanized trace semantics / proof envelopes                                   | OUT OF SCOPE | The production runtime is explicitly outside Shepherd's own proof boundary; Brewva's analogue is fitness tests (axiom 19), which already exist.                         |
| Shepherd as an embedded substrate dependency                                        | REJECT       | Python-only, no server or wire protocol (CLI `--json` is batch, process-per-op), run-to-completion task model, three kernel generations in flux in a ~6-week-old alpha. |

## Loop 1: Checkpoint-Coupled World Snapshots

**Thesis.** A rewind checkpoint should name a world, not just a conversation
position. Capture is coupled to the boundary the tape already treats as
durable: `checkpoint.committed` is the existing fsync boundary in
`packages/brewva-runtime/src/runtime/tape/impl.ts`, and the rewind engine
already derives its patch window from checkpoint order.

### Option A (chosen): private git-object world store, hybrid with live carriers

Durable checkpoint worlds are **content-addressed git trees in a private object
store** under `.brewva/worlds/` — a bare object database whose work-tree is
pointed at the workspace for capture (`git --git-dir … --work-tree … write-tree`
semantics), never the user's own `.git`. Properties: O(changed-bytes) capture
after the first snapshot, content dedup across checkpoints, cross-platform,
GC by dropping refs. Live forks (Loop 2) use copy-on-write directory carriers
instead (APFS `clonefile` on Darwin, plain copy as the portable floor), because
a subagent needs an executable working directory, not a restore point. This
hybrid mirrors what the Shepherd repo itself converged on (git-tree worlds +
clonefile carriers), independently validating the split.

Rejected alternatives: per-checkpoint clonefile directory clones as the durable
store (APFS-only, O(n) restore, inode-heavy, no dedup); qcow2 guest snapshots
(disqualified twice over — `restore` has no product callers, and the
bind-mounted workspace was never inside the guest disk); writing snapshot refs
into the user's repository (invasive to gc/size and breaks on non-git
workspaces).

### Mechanics

- **Trigger**: capture at each `checkpoint.committed` whose preceding turn
  contained a workspace mutation (patch applied, or an exec whose effect set
  includes `workspace_write`) — derivable from the tape, no new sensor. Clean
  turns reuse the previous world oid for free.
- **Capture scope**: tracked plus untracked-unignored files, excluding the
  runtime's own data roots (`.brewva`, the session patch-history root, the
  world store itself). Ignored files sit outside the restore promise, same
  boundary git users already understand; the boundary is documented, not
  silent.
- **Receipt shape**: no new canonical event type. The checkpoint payload gains
  an optional `world` block (`oid`, capture stats); restore emits through the
  existing rewind transaction receipts (`session.rewind.completed` gains a
  `worldRestore` outcome). Keeps the 15-type kernel grammar closed (axioms 15,
  16).
- **Restore**: materialize the target tree over the workspace and delete
  captured-scope files that the target lacks — but first capture the
  pre-restore state as a world of its own. Restore is a new edge, never a
  rewrite; redo-after-rewind stays trivially safe, matching the tape's own
  grammar.
- **Rewind semantics**: `code`/`both` prefer the world lane when the boundary
  checkpoint carries a world; the patch-unwind lane remains for uncovered
  checkpoints and as the preview comparator. Preview reports which lane is
  available honestly — `world`, `patch`, or `inconclusive` (axiom 7) — instead
  of today's binary readiness.
- **Durability class**: worlds are **durable transient** in the
  [durability taxonomy](../decisions/durability-taxonomy-and-rebuildable-surface-narrowing.md)
  (capture-time evidence, not rebuildable, retention-bounded), alongside the
  rollback artifacts in `packages/brewva-vocabulary/src/internal/durability.ts`.
  Retention is config-bounded per session; release on session archive.
- **Integrity**: the world store gives the `artifact` dimension of
  `getIntegrity` (today `inconclusive` per the inspect-replay RFC) something
  real to verify: ref → oid reachability is a cheap deterministic check.

This is also the honest fix for the patch lane's sharpest edge: after Loop 1, a
missing rollback artifact degrades a window rewind to the world lane instead of
failing the whole transaction, and `exec`-written files are inside the promise
for the first time.

## Loop 2: Delegation Changeset Physics

**Thesis.** Give the declared archetype its physics. The vocabulary already
promises everything Shepherd's retained-output lane offers: the
`patch-snapshot` archetype produces "a `PatchSet` that the parent must
explicitly adopt", worker dispositions run
`pending_apply → prepared → applied | apply_failed | rejected | superseded`,
and `deriveDelegationAdoptionRequirement` makes adoption an obligation
(`packages/brewva-vocabulary/src/internal/delegation.ts`). What is missing is
the isolation itself: today the registry
(`packages/brewva-gateway/src/delegation/catalog/registry.ts`) stamps
`isolationStrategy: "snapshot"` and no code materializes it.

### Mechanics

- **Fork**: when a `patch-snapshot` run starts, fork a live world from the
  parent's current workspace state via the carrier (clonefile on Darwin, copy
  floor elsewhere; the floor is O(n) and documented as small-workspace-only —
  the same honesty Shepherd applies to its own `cp -a` fallback). The worker's
  `read`/`edit`/`write`/`exec` resolve against the fork root; the parent
  workspace is untouched by construction, not by discipline.
- **Seal**: on completion, diff the fork against its recorded basis oid and
  seal the delta as the run's `PatchSet` — the same artifact the adoption
  contract and patch receipts already carry. The fork directory is then
  disposable; the sealed changeset plus basis/result oids are the durable
  record.
- **Settle**: adoption maps onto Shepherd's verb discipline without new
  dispositions: `applied` requires fast-forward (parent world unchanged since
  basis) or path-disjoint apply onto a moved parent; any overlap fails closed
  to `apply_failed` with the diff retained — re-merging is the model's job
  (axiom 10), never kernel content synthesis. `rejected` discards the sealed
  changeset; `superseded` stays as-is.
- **Boundary payoff**: `readonly-shared` and `exec-ephemeral` archetypes gain
  nothing and lose nothing; the change is confined to the one archetype whose
  description already promised it. Parallel workers stop being able to trample
  each other or the parent — the CooperBench failure mode Shepherd's
  supervisor exists to police is instead removed by construction.

## Loop 3: Reversibility Tiers

**Thesis.** Approval currently answers "may this happen"; nothing answers "can
this be undone". Shepherd tags every effect with a reversibility tier at
authoring time. Brewva should **derive** the tier instead — from lane coverage
that already exists — and project it, because descriptive metadata derives
views, never authority (axiom 18).

- **Vocabulary**: `reversible | compensable | irreversible` on effect
  commitments. Derivation: patch-lane writes → `reversible` (rollback
  artifact); any workspace mutation inside a world-covered turn → `reversible`
  (world lane, Loop 1) — this is what upgrades `exec`; network and other
  external effects → `irreversible`; unknown coverage → `inconclusive`, stated
  plainly (axiom 7).
- **`compensable` is a reserved slot, not an authoring surface.** No
  compensator exists in the product today; building an authored compensation
  contract before the first real one would be a switch nobody flips (axiom 3).
  The enum carries the slot so the taxonomy is stable; authoring lands only
  with the first concrete compensable effect.
- **Projection**: the approval card and the rewind preview render the tier
  ("this commitment cannot be undone by rewind"); the Work Card evidence view
  may aggregate it. No gate, no admission change, no ranking: a fitness pins
  that no authority path reads the tier (axiom 19 applied to axiom 18's
  boundary).

## Loop 4: The Supervision Surface (Gated)

**Thesis.** Shepherd's CooperBench result is a meta-agent driving three verbs
over worker harnesses. Brewva already owns stronger versions of all three; the
gap is only that no session can hold them over another session as tools.

- observe → session-index projections and tape reads, explicit-pull, under the
  shared projection discipline (no auto-push into model context)
- inject → an append to the child's durable steering inbox
  (`packages/brewva-gateway/src/hosted/internal/session/managed-agent/steering-sidecar.ts`)
- handoff → start a sibling session forked from a chosen tape leaf — preserving
  the conversation prefix, which is strictly stronger than Shepherd's
  memory-wiping session restart
- discard → the Loop 1 coupled rewind of the child

Landing shape: one delegation capsule plus thin managed tools over existing
ops. Constraints that keep it constitutional: opt-in control-plane only, never
default-path (axiom 17); the supervisor is a model-driven session, not a kernel
policy engine (axioms 2, 12); the authority-bearing transaction boundary stays
`single tool call` — no cross-agent saga semantics. This loop is explicitly
gated behind Loops 1–2 proving out and may be split off or archived without
touching them.

## Landing Plan

1. **Phase 1 — world store + capture** (Loop 1 mechanics behind config
   `workspace.worldSnapshots.enabled`, default off until Phase 2): capture,
   retention/GC, checkpoint payload block, inventory in rewind preview.
2. **Phase 2 — world-restore lane** in the rewind transaction engine +
   preview honesty + integrity artifact check; flip default on for Darwin.
3. **Phase 3 — delegation changeset physics** (Loop 2): carrier fork, seal,
   settle mapping; E2E over a real worker run.
4. **Phase 4 — tiers** (Loop 3): derivation + projection + the no-authority
   fitness.
5. **Phase 5 — supervision surface** (Loop 4): gated on 1–3; separate go/no-go.
   Resolved **NO-GO / DEFER** (see Implementation state) — no consumer exists,
   so the surface would be dead. Stays specified-not-built pending a concrete
   model-driven supervisor consumer.

## Validation Signals

- world capture p50 under ~500 ms cold and ~O(delta) warm on a 10k-file
  workspace (Darwin); carrier fork p50 under ~150 ms clonefile — measured, not
  asserted, before defaults flip
- a new integration test rewinds a turn whose only mutation came from `exec`
  and observes the file restored — impossible on current `main`
- degraded-artifact drill: delete one `rollback.json` from a window, observe
  the world lane recover what the patch lane refuses, with honest receipts
- delegation E2E: worker edits in a forked world; parent tree byte-identical
  until `applied`; overlap settles `apply_failed` with diff retained
- world-store GC leaves no orphaned objects after session archive; disk growth
  bounded by retention config across a long dogfood session
- tier fitness: grep-level guard that no admission/approval/routing code path
  reads the tier; projection renders in approval card and rewind preview
- both gates green: `bun run check` and the full `bun test` suite

## Surface Budget

_Net additions introduced by this RFC (Loops 1–3; Loop 5 gated and uncounted)._

| Surface                               | Before | After | Notes                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | -----: | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | Nothing new required from tool or capsule authors.                                                                                                                                                                                                                                                 |
| Optional authored fields              |      0 |     0 | Tiers are derived, not authored; `compensable` authoring is explicitly deferred until a first real compensator exists.                                                                                                                                                                             |
| Author-facing concepts                |      0 |    +2 | `world snapshot` and `reversibility tier`. Debt owner: runtime + tools maintainers. Unavoidable: an undocumented restore point is folklore (axiom 19), and an unnamed tier cannot be projected. Re-evaluate `2026-10-31`.                                                                          |
| Inspect surfaces                      |      0 |    +2 | World inventory inside the existing rewind preview; sealed-changeset review view under the shared inspect host. Both explicit-pull.                                                                                                                                                                |
| Routing/control-plane decision points |      0 |    +2 | Rewind lane selection (world vs patch, deterministic from coverage); delegation settlement verb (ff/disjoint/fail-closed). Debt owner: gateway maintainers. Unavoidable: each is the point of its loop — a single deterministic branch replacing a silent under-promise. Re-evaluate `2026-10-31`. |
| Public tools                          |      0 |     0 | Loop 4's supervision tools are gated and counted at their own go/no-go, not here.                                                                                                                                                                                                                  |
| Config keys                           |      0 |    +1 | One namespace: `workspace.worldSnapshots` (`enabled`, retention). Defaults conservative in `packages/brewva-runtime/src/config/defaults.ts`.                                                                                                                                                       |

Surface-affecting promotion requires runtime/gateway maintainer review.

## Promotion Criteria

- Phases 1–3 landed with the validation signals above measured green in a real
  dogfood session (not only fixtures), including one genuine
  exec-damage-then-world-rewind recovery and one delegation changeset adopted
  end-to-end
- the durability taxonomy, rewind journey, and proposal-boundary docs updated
  to carry the world lane and tier contracts; this note then converts to a
  decision record per lifecycle rules
- Loop 3 may promote independently of Loops 1–2 if tiers prove useful first;
  Loop 4 promotes separately or is archived without prejudice
- if Darwin capture latency or disk retention misses its gate, the world store
  ships as opt-in tooling only and the patch lane remains the default promise —
  recorded honestly rather than silently

## Open Questions

- capture cadence under very chatty sessions: every mutating checkpoint vs a
  bounded stride with patch-lane coverage in between
- the portable floor: is O(n) copy acceptable for delegation forks on Linux
  dev machines, or should `patch-snapshot` degrade to `shared` + patch-lane
  there until an overlay carrier exists
- whether restore should also re-anchor unsaved editor state signals (out of
  scope for the engine; a CLI concern)
- whether the sealed-changeset review view should reuse the existing patch
  inspect rendering or needs a dedicated diff surface
- greenfield naming: `world` vs `workspace snapshot` in operator-facing copy
  (the tape already uses `checkpoint` for the conversation axis)

## Source Anchors

- Rewind engine and transaction receipts:
  `packages/brewva-gateway/src/hosted/internal/session/recovery/rewind-engine.ts`,
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/patches/rollback.ts`
- Patch lifecycle and its coverage boundary:
  `packages/brewva-tools/src/patch-lifecycle/rollback.ts`,
  `packages/brewva-tools/src/families/navigation/source-patch.ts`
- Dormant box snapshot plane and the bind-mount disqualifier:
  `packages/brewva-tools/src/internal/box/boxlite/plane.ts`,
  `packages/brewva-tools/src/internal/box/contract.ts`
- Tape, checkpoint boundary, event grammar:
  `packages/brewva-runtime/src/runtime/tape/impl.ts`,
  `packages/brewva-runtime/src/runtime/runtime-api.ts`
- Delegation vocabulary and the hollow `snapshot` strategy:
  `packages/brewva-vocabulary/src/internal/delegation.ts`,
  `packages/brewva-gateway/src/delegation/catalog/registry.ts`,
  `packages/brewva-gateway/src/delegation/execution-plan.ts`
- Steering inbox (Loop 4's inject):
  `packages/brewva-gateway/src/hosted/internal/session/managed-agent/steering-sidecar.ts`
- Contracts this RFC extends:
  `docs/reference/proposal-boundary.md`, `docs/reference/runtime.md`,
  `docs/architecture/design-axioms.md`,
  [session-rewind-as-conversation-fork-primitive](../decisions/session-rewind-as-conversation-fork-primitive.md),
  [rollback-ergonomics-and-patch-lifecycle-safety](../decisions/rollback-ergonomics-and-patch-lifecycle-safety.md),
  [effect-approval-and-rollback-closure](../decisions/effect-approval-and-rollback-closure.md),
  [session-tree-navigation](../decisions/session-tree-navigation.md)
- Peer: Shepherd paper arXiv 2605.10913v3; repo `/Users/bytedance/new_py/shepherd`
  (external) — `VcsCore` fork/seal/merge/discard verbs, `ClonefileCarrierBackend`
  and the copy floor, `SQLiteTraceStore` content-addressed fact DAG, settlement
  CLI, in-memory `Checkpoint` stream truncation, and the absence of any durable
  mid-run fork or wire protocol (evaluated 2026-07-08)

Under the line: `A checkpoint names a world, not just a conversation; a
delegated edit lands only when adopted; every effect knows its way back — or
says it has none.`
