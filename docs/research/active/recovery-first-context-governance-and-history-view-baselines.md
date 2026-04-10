# Research: Recovery-First Context Governance And History-View Baselines

## Document Metadata

- Status: `active`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-10`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/working-projection.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Problem Statement And Scope Boundaries

Brewva already has strong durability boundaries, replay-first recovery, deterministic
context admission, and explicit advisory-memory contracts. What it still lacks is a
shared state contract between context governance and recovery.

The repository already distinguishes:

- `durable source of truth`
- `durable transient`
- `rebuildable state`
- `cache`

However, the model-visible context path still has four unresolved gaps:

1. There is no explicit, rebuildable model-visible baseline after `session_compact`,
   and current compaction bookkeeping is too thin to reconstruct one from durable
   authority outputs alone.
2. Hosted transition snapshots and the current recovery working set are useful, but
   they still behave primarily as presentation blocks rather than as a formal read model.
3. Request-local reduction, working projection, advisory memory, and post-compact
   continuity do not yet share a single layering contract. Left alone, that gap will
   eventually produce compaction-only prompt patch paths.
4. Narrative memory and deliberation memory are now stable products, but without a
   stronger contract they are easy to misuse as compact baselines or resume truth.

This note covers:

- the shared state layers between context governance and recovery
- the model-visible baseline contract after `session_compact`
- the recovery order around canonicalization, hydration, and baseline rebuild
- the boundary between request-local reduction, replay-visible rewrite, and advisory recall

This note does not reopen:

- the rule that `session_compact` is the only replay-visible history rewrite authority
- the non-authoritative sibling-product status of narrative memory
- the status of working projection as rebuildable state
- provider-specific caching APIs
- existing WAL, tape, approval, or reasoning-revert authority semantics

## Relationship To Existing Research

This note complements existing active research rather than replacing it:

- `prefix-stable-context-management-and-progressive-compaction.md`
  focuses on stable prefixes, deterministic tails, and request-local reduction
- `context-budget-behavior-in-long-running-sessions.md`
  focuses on budget shaping and long-history behavior
- `recovery-robustness-under-interrupt-conditions.md`
  focuses on interrupt recovery, replay, and WAL interaction

This note addresses one cross-cutting question that those notes leave open:

`What should the model see after compaction, and how should recovery rebuild that view?`

## Comparative Findings

The reference systems point to complementary lessons rather than a single template.

### Claude Code

Claude Code is most useful as a recovery-order reference:

- canonicalize transcript shape before resume
- apply request-local degradation before replay-visible history rewrite

The key lesson is not "compact more aggressively." It is "repair semantic shape
before attempting continuation."

### Codex

Codex is most useful as a baseline-design reference:

- `replacement_history`
- `reference_context_item`
- reverse replay that reconstructs compaction checkpoints

The lesson is that post-compact continuity becomes fragile if the system lacks a
formal history-view baseline and instead relies on ad hoc prompt patching.

### Brewva

Brewva already has the right foundational boundaries:

- durability taxonomy across tape, WAL, rebuildable state, and cache
- a `ContextComposer` that owns presentation rather than admission or replay
- working projection that is explicitly non-authoritative
- narrative memory that is explicitly non-truth
- an initial recovery working set that already behaves like a minimal resume contract

That means Brewva does not need to copy Claude Code or Codex wholesale. It needs
to formalize one missing layer in its own contract stack.

## Decision Options

### Option A: Keep Existing Boundaries And Improve Only Prefix Stability And Reduction

This option keeps the current layering intact and limits changes to:

- stable prefix work
- dynamic-tail canonicalization
- micro reduction
- compact prompt quality

Benefits:

- smallest implementation surface
- aligns tightly with the current active prompt-shaping RFC

Costs:

- post-compact continuity still depends on reinjection heuristics
- the recovery working set remains a presentation helper rather than a formal read model

Assessment:

- useful as a short-term increment
- insufficient as the long-term contract

### Option B: Use Advisory Memory As A Memory-First Compact Baseline

This option uses deliberation or narrative memory in place of a compact-generated baseline.

Benefits:

- could reduce some compact-time model calls
- appears to reduce compact latency

Costs:

- breaks replay equivalence and incident explainability by letting advisory material
  define model-visible post-compact history
- risks freezing session-start snapshots or stale recall into compact baselines
- creates a second implicit truth source

Assessment:

- memory may improve compact inputs when provenance remains visible
- memory should not define the compact baseline or the post-compact history view

### Option C: Introduce A Rebuildable History-View Baseline

This option keeps tape truth unchanged while introducing a rebuildable,
artifact-backed history-view baseline for the post-compact and post-recovery
model-visible history.

Benefits:

- preserves Brewva's current authority boundaries
- turns compact continuity into an explicit contract instead of a patch path
- composes naturally with replay-first recovery, working projection, and the recovery working set

Costs:

- introduces a new rebuildable-state contract
- requires missing-artifact rebuild logic and validation coverage

Assessment:

- recommended

## Proposed Contract

### Principle

Context governance and recovery should share four state planes:

1. `Authority Plane`
2. `History-View Plane`
3. `Working-Set Plane`
4. `Advisory Memory Plane`

Only the first plane is authority for replay correctness. The other three planes
must remain explainable, rebuildable, and disposable.

### 1. Authority Plane

This plane remains unchanged and continues to include only:

- event tape
- checkpoints
- reasoning receipts
- approval truth
- turn receipts
- Recovery WAL

Rules:

- replay correctness derives only from this plane plus workspace state
- compaction summaries, working projection artifacts, and startup recall must not
  be promoted into this plane

### 2. History-View Plane

This is the core addition proposed by this note.

Definition:

- the `History-View Plane` is a rebuildable model-history baseline
- it represents the history the model should see after compaction or branch reset
- it is not tape truth and not a new durable event family

At minimum it must capture:

- baseline identity
- the latest surviving compact or branch-reset authority reference
- a sanitized transcript-equivalent rewrite artifact or durable artifact pointer
- a digest of that sanitized model-visible form
- the source turn or source receipt that produced the baseline
- the leaf or branch-lineage anchor that scopes the baseline
- the reference-context digest or baseline reference compatible with that rewrite

Rules:

- the baseline may only be derived from existing replay-visible authority such as
  `session_compact` or a completed reasoning branch reset
- the plane may contain only transcript-equivalent rewrite outputs anchored to a
  single authority event
- it must not contain task state, blocker state, delegation outcomes, tool-lifecycle
  hints, resume instructions, or advisory memory content
- the canonical baseline form is the sanitized compact output, not raw provider text
- the baseline is leaf-scoped; cross-leaf reuse requires explicit branch-reset authority
- if the baseline artifact is missing, the system must rebuild it from durable receipts
- advisory memory may inform compact inputs, but it may not directly define the baseline

The goal is not to introduce a second truth source. The goal is to make the
model-visible post-compact history explicit.

### 3. Working-Set Plane

The `Working-Set Plane` is the minimal task contract used for recovery and continuation.

It should evolve from the existing recovery working-set read model rather than introducing
a second hidden recovery hint system.

At minimum it must capture:

- latest recovery reason and pending family
- active task goal, phase, and health
- acceptance status
- open blockers
- pending delegation outcomes
- open tool lifecycle and effect-replay guards
- the `resume_contract` that the recovery turn must obey

Rules:

- force injection only for recovery, output-budget, and branch-reset families
- treat it as a read model, not as tape truth
- derive it only from the authority plane plus existing rebuildable helpers
- keep all operational recovery guidance in this plane rather than leaking it into
  the history-view baseline

### 4. Advisory Memory Plane

This plane continues to carry:

- narrative memory
- deliberation memory
- optimization continuity
- startup recall

Rules:

- it remains advisory
- it continues to require provenance, freshness, and verify-before-trust cues
- it must not become the sole source of a compact baseline
- it must not introduce a second hidden budget plane outside existing arena and hosted shaping

Put differently: startup recall is allowed, but it must stay inside the current
recall and working-admission system rather than becoming an independent planner budget.

## Recovery Pipeline

Recovery should converge on an explicit five-step sequence.

### Step 1: Canonicalize Before Hydration

On resume, the system should repair shape before it attempts continuation.

This section describes the target recovery order. The current implementation still
performs unclean-shutdown diagnosis after authority hydration and fold application;
Phase 1 of this note formalizes canonicalization as a pre-hydration pass without
changing replay truth.

That pass should clean or explicitly diagnose at least:

- unclosed tool lifecycle state
- interrupted attempt-scoped live-only state
- duplicated continuation residue from compact or recovery families
- invalid presentation-only helper state

If canonicalization fails, the system should enter a degraded diagnostic state
rather than pretending the session is a clean cold start.

### Step 2: Hydrate Authority State

The authority-state phase should remain replay-first:

- tape replay
- checkpoint plus delta fold
- reasoning lineage reconstruction
- WAL-based in-flight envelope recovery

This layer must not be rewritten by compaction helpers or memory helpers.

### Step 3: Rebuild The History-View Baseline

If a history-view artifact exists and passes integrity checks, use it.

If it is missing:

- rebuild it from surviving compaction-authority outputs and branch-reset receipts
- fall back to authority-derived exact history when rebuild is impossible or the
  session predates enriched compaction metadata
- if exact-history fallback still exceeds admission budget, enter degraded recovery
  diagnostic mode rather than silently truncating baseline truth
- never fall back to process-local prompt patch state

### Step 4: Build The Working-Set Read Model

Use current task, transition, delegation, and tool-lifecycle state to build a
minimal continuation contract that tells the model:

- why recovery is happening
- where work should resume
- which side effects must not be replayed

### Step 5: Run Standard Deterministic Admission

Neither post-compact nor post-recovery should have a separate prompt patch path.

The correct sequence is:

- rebuild the baseline
- generate the working set
- run the normal deterministic admission and composition path

This preserves the `ContextComposer` boundary: presentation only, not replay or recovery assembly.

## Governance Ladder

Under this contract, Brewva's context-governance ladder should be:

### Layer 0: Canonicalize And Diagnose Recovery Posture

Before composition work begins, recovery should:

- detect unclean shutdown and incomplete attempt-local state
- reconcile open tool lifecycle and effect-replay posture
- decide whether the session is resumable, degraded, or operator-visible diagnostic only

### Layer A: Stable Prefix And Deterministic Tail

Keep the current active RFC direction:

- stable prefix
- canonicalized scoped tail
- no-op behavior when semantic state has not changed

### Layer B: Request-Local Reduction

Allow request-local reduction only when it satisfies all three guards:

- it does not sever open tool lifecycle state
- it does not cross pending recovery-family or branch-reset boundaries
- it does not rewrite replayable history

This means a naive "truncate by user-turn boundary" rule is not sufficient for Brewva.
The reduction path must also be recovery-aware.

### Layer C: Replay-Visible Compaction

`session_compact` remains the only authority.

Its output should serve two purposes:

- produce a handoff-quality structured summary
- update the rebuildable history-view baseline artifact or its durable reference

Advisory memory may provide candidate material with provenance, but it should not
be treated as the compact result itself.

### Layer D: Advisory Startup Recall

Startup recall is allowed, but only as an advisory context source:

- it must not live outside arena shaping
- it must not bypass the normal admission path
- it must not become the compact baseline

## Budget-Class Mapping And Admission Guarantees

The four planes must align with the existing arena budget model:

- authority-derived system contract remains `core`
- the history-view baseline is `core`, must reserve a non-best-effort slice, and
  must not be admitted only through generic supplemental-context append paths
- the working-set plane is `working`
- advisory memory remains `recall`

This mapping preserves the meaning of "baseline." If the history-view baseline were
treated as an ordinary supplemental block, it would become truncatable best-effort
content rather than a model-visible continuity contract.

## Design Constraints

The following constraints must remain true:

1. `session_compact` remains the only replay-visible history rewrite authority.
2. Narrative memory remains a non-authoritative sibling product.
3. Working projection remains rebuildable state rather than a default workflow brief.
4. Recovery consults durable artifacts before process-local helper state.
5. `ContextComposer` does not take ownership of replay, admission, or recovery semantics.

## Baseline Precedence And Degradation Rules

The baseline contract must specify precedence and fallback explicitly:

- `compact -> compact`: the latest surviving compact authority on the active leaf wins
- `compact -> revert`: a completed branch reset invalidates the superseded leaf baseline;
  rebuild from the target leaf and reset authority anchor
- `revert -> compact`: the post-revert compact supersedes the inherited baseline on the
  new active leaf
- old sessions that lack enriched compaction metadata or baseline artifacts must fall
  back to exact-history replay
- if exact-history replay cannot fit the admission budget, recovery must enter degraded
  diagnostic mode rather than silently dropping baseline truth

## Phased Rollout

### Phase 0

- enrich the compaction-authority path with enough durable material to rebuild
  post-compact history view
- persist or reference the sanitized compact output, its digest, the source turn
  or receipt, the lineage anchor, and the compatible reference-context digest
- do not create a second authority source or a separate durable event family

### Phase 1

- formalize the recovery working-set read model as a stable runtime surface
- add canonicalization before resume as a first-class pre-hydration pass
- strengthen working-set coverage for open tool lifecycle and effect-replay guards

### Phase 2

- introduce the history-view baseline artifact
- allow both `session_compact` and branch-reset recovery to rebuild that baseline
- support legacy sessions by degrading to exact-history fallback when the artifact
  or enriched authority metadata is unavailable

### Phase 3

- upgrade request-local reduction into a recovery-aware reduction ladder
- connect startup recall explicitly to the existing admission and budget path

### Phase 4

- expose inspect and metric surfaces for:
  - baseline rebuild hit rate
  - reduction effectiveness
  - degraded recovery fallback rate
  - duplicate side-effect attempt rate after recovery

## Source Anchors

- Session lifecycle and durability taxonomy:
  `docs/reference/session-lifecycle.md`
- Context presentation contract:
  `docs/reference/context-composer.md`
- Working projection contract:
  `docs/reference/working-projection.md`
- Narrative memory contract:
  `docs/research/promoted/rfc-narrative-memory-product-and-bounded-semantic-recall.md`
- Active prompt-shaping RFC:
  `docs/research/active/prefix-stable-context-management-and-progressive-compaction.md`
- Recovery working set implementation:
  `packages/brewva-runtime/src/recovery/read-model.ts`
- Session lifecycle hydration:
  `packages/brewva-runtime/src/services/session-lifecycle.ts`
- Hydration-time tool lifecycle diagnosis:
  `packages/brewva-runtime/src/services/session-hydration-fold-tool-lifecycle.ts`
- Compaction bookkeeping and sanitization:
  `packages/brewva-runtime/src/services/context-compaction.ts`
  `packages/brewva-gateway/src/runtime-plugins/context-shared.ts`
- Hosted compaction event handling and branch checkpoints:
  `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
  `packages/brewva-runtime/src/tape/reasoning-events.ts`
- Context admission and scope dedupe:
  `packages/brewva-runtime/src/services/context.ts`
  `packages/brewva-runtime/src/context/injection-orchestrator.ts`
- Arena budget classes:
  `packages/brewva-runtime/src/context/sources.ts`
  `packages/brewva-runtime/src/context/arena.ts`

## Validation Signals

Existing validation must not regress:

- `test/live/cli/replay-and-persistence.live.test.ts`
- `test/live/cli/signal-handling.live.test.ts`
- `test/contract/runtime/context-budget.contract.test.ts`
- `test/contract/runtime/context-injection.contract.test.ts`

Additional validation needed for this contract includes:

- rebuilding the history-view baseline artifact from receipts when the artifact is missing
- rebuilding the history-view baseline from enriched compaction authority outputs when
  the artifact is missing
- verifying that post-`session_compact` recovery does not depend on compaction-only prompt patches
- proving that recovery-aware reduction never severs open tool lifecycle state
- proving that reasoning-revert and WAL resume paths do not replay completed side effects
- proving that exact-history fallback over budget produces degraded recovery diagnostics
- proving precedence rules across `compact -> compact`, `compact -> revert`, and
  `revert -> compact`
- proving that missing or deleted startup recall does not affect replay correctness

## Promotion Criteria

- stable docs distinguish the four planes clearly:
  authority truth, history-view baseline, working set, and advisory memory
- reference docs explain the model-visible baseline after `session_compact`
- recovery docs describe the sequence:
  canonicalize -> hydrate -> rebuild baseline -> build working set -> normal admission
- recovery docs explicitly distinguish target recovery order from current post-hydration
  diagnosis behavior during rollout
- operator journey docs explain missing-baseline, damaged-artifact, and duplicate-side-effect incidents
- operator journey docs explain degraded recovery when exact-history fallback exceeds budget
- inspect and metric surfaces distinguish replay-correctness issues from helper-artifact loss
