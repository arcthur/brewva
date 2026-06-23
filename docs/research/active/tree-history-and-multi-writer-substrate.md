# Tree History And Multi-Writer Substrate

## Metadata

- Status: active
- Implementation state: not started; model-level exploration. No code change is
  proposed here — this note frames the fork and records the decision axes.
- Owner: Runtime and gateway maintainers
- Last reviewed: `2026-06-22`
- Relates to:
  - [Decision: Crash-Safe Durable Substrate For Tape And Recovery WAL](../decisions/crash-safe-durable-substrate.md)
    (table stakes for any future; deliberately does not resolve this fork)
  - [RFC: Inspect, Replay, And Recovery Optimization](./rfc-inspect-replay-and-recovery-optimization.md)
    (owns the replay / rewind / redo engine that today substitutes for a tree)
  - [Journey: WAL And Crash Recovery](../../journeys/internal/wal-and-crash-recovery.md)
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/journeys/internal/wal-and-crash-recovery.md`

## Problem Statement

Brewva models a session's history as a **linear append**: the `event tape` is one
append-only file per session, deduped by event id, and undo / redo / rewind are
provided by a separate replay / `PatchSet` engine rather than by navigating a tree.
This is clean and highly auditable under one host and one writer per session.

A genuinely "future-facing model" almost certainly implies one or more of:
sub-agents with their own histories, concurrent sessions, and branch-and-explore
history. The substrate that serves those is not the same substrate brewva has
today, and crash-safety alone (atomic rewrite + fsync, the crash-safe substrate
RFC) does not get there: the **per-session single-append-fd** assumption is a
single-writer assumption, and `fsync` does not relax it. Going multi-writer or
distributed changes the substrate itself.

This note exists to make that a **deliberate decision** rather than a drift. It is
explicitly the fork the crash-safe substrate RFC is table stakes for but declines
to resolve.

## The Peer Landscape (Stated Precisely)

The three sibling runtimes do not all do the same thing; the distinction matters:

- **pi-mono** — an explicit parent-pointer tree: each entry carries `parentId`,
  and the current position is itself an appended `LeafEntry`, so branching is free
  and the leaf pointer is recoverable. Compaction is non-destructive (a
  `CompactionEntry` records the first kept entry).
- **claude-code** (per review) — also an explicit tree: messages carry
  `parentUuid` (plus a `logicalParentUuid`), with sidechain transcripts for
  sub-agents and content-replacement back into the main chain. Tree-shaped by
  construction.
- **opencode** — _not_ a parent-pointer tree. It is event-sourced in SQLite
  (`EventTable` / `EventSequenceTable` keyed by `(aggregate_id, seq)`) projected
  into a `SessionMessageTable`; per-session it is closer to a linear sequence than
  a tree, recovered by idempotent projection.

So the honest framing is: two of the three peers are parent-pointer trees;
opencode is sequence-event-sourced; brewva is linear-append plus a replay engine.
**Brewva's linear+replay is not "behind" — it is a more-auditable choice** (every
state is a real, replayable event; undo is `PatchSet` rollback over true events,
not tree navigation). The question is not "catch up to the peers"; it is "decide
the model deliberately, because the substrate constrains the futures it can serve."

## Scope Boundaries

In scope — the model decision on two axes:

- history shape (linear+replay vs parent-pointer vs full tree);
- writer model (single-writer-per-session vs multi-writer / distributed).

Out of scope:

- the mechanical crash-safety (the crash-safe substrate RFC);
- the replay / rewind / redo engine internals (the inspect-replay RFC); this note
  decides the data model the engine operates on, not the engine.

## Decision Axes

### Axis 1 — History shape

- **(a) Stay linear + replay engine.** Most auditable; undo/redo/rewind already
  exist via `PatchSet`. Branching is expressed by replay, not by structure.
- **(b) Add a parent pointer to canonical events.** Append-only-compatible — it is
  "just a field" on the event, not a new store or a rewrite path — so it does not
  threaten "tape owns truth." It unlocks cheap structural branching and a
  recoverable cursor while keeping the linear file. This is the synthesis: tree
  navigability **and** append-only auditable truth.
- **(c) Full parent-pointer tree + leaf-as-append** (pi-mono / claude-code style).
  Most natural for fork-heavy UX; the largest change to the tape's shape and to
  every projection that reads it.

### Axis 2 — Writer model

- **(a) Single-writer-per-session** (today). One append fd per session; no CAS
  needed because there is no concurrent writer. Clean; this is why the crash-safe
  RFC scopes CAS out.
- **(b) Multi-writer / concurrent** (sub-agents or concurrent sessions writing the
  same history). The per-session single-append-fd model breaks: it needs either
  per-writer logs that merge deterministically, a write coordinator, or a store
  with real concurrent-append semantics — plus the `revision` / CAS the crash-safe
  RFC deferred. This is a substrate change, not an addition.

## Positions And Lean

- **Linear is a position, not a deficiency.** Adopt a tree only if branch-heavy UX
  (fork-at-step-N, explore alternates) is a committed product direction — not to
  match the peers.
- **Axis 1(b) is the cheap forward-compatible hook.** A parent pointer on canonical
  events is the one thing worth adding even in today's single-writer world,
  because it keeps the door to branching open without abandoning append-only
  truth — but only if branching is on the roadmap. Absent that, axiom 3
  (subtraction beats switches) says do not add it speculatively.
- **Axis 2(b) is requirement-triggered, not pre-built.** Multi-writer machinery
  (per-writer logs / coordinator / CAS) should be introduced when an actual
  sub-agent-concurrency or distributed requirement lands, not in anticipation. The
  delegation plane today gives each delegated turn its own session id and therefore
  its own tape file — already a form of per-writer isolation — so the first real
  question is whether sub-agents ever need to write a **shared** history at all.

## Source Anchors

Brewva (the linear substrate this fork would change):

- `packages/brewva-runtime/src/runtime/tape/impl.ts` — one append fd per session
  (`getAppendFileDescriptor` 571 / `openSync(filePath, "a")` 581), linear append
  with id dedupe (`appendEventToMemory`), no parent pointer on `CanonicalEvent`.
- The replay / rewind / redo engine and `PatchSet` rollback — owned by the
  inspect-replay RFC and `docs/journeys/operator/inspect-replay-and-recovery.md`.
- Delegation per-session isolation — `docs/research/decisions/delegation-plane-hardening-and-envelope-archetype-cutover.md`.

External comparison (the peer models, not brewva paths):

- pi-mono: `/Users/bytedance/new_py/pi-mono/packages/agent/src/harness/session/`
  (`jsonl-storage.ts`, `session.ts`) — `parentId` chain + `LeafEntry`,
  non-destructive `CompactionEntry`.
- opencode: `/Users/bytedance/new_py/opencode/packages/core/src/session/` (`sql.ts`
  event tables, `projector.ts`) — sequence-event-sourced, not a parent tree.
- claude-code: `parentUuid` / `logicalParentUuid` message tree with sidechain
  transcripts (reported in review; not independently re-read here).

## Validation Signals

This note records a model decision; it has no code to test until an option is
chosen. The decision's quality is validated by:

- a stated product position on branch-heavy UX and sub-agent shared-history needs
  (the input to Axis 1 and Axis 2);
- if Axis 1(b) is adopted, a migration sketch showing the parent pointer is
  additive (old tapes load with a null parent) and every projection tolerates it.

## Promotion Criteria

- A recorded decision on both axes in `design-axioms.md` and
  `system-architecture.md`, with the reasoning (especially: why linear+replay is
  kept, or what concrete requirement triggers the move).
- If a parent pointer is adopted, `runtime.md` documents the `CanonicalEvent`
  field and its append-only, nullable, projection-tolerant contract.

## Open Questions

- Do brewva sub-agents ever need to write a **shared** history, or is per-session
  isolation (one tape file per delegated session) sufficient indefinitely? The
  answer largely decides whether Axis 2(b) is ever needed.
- If branching is wanted, can the existing replay / `PatchSet` engine express
  fork-at-step-N over a parent pointer without a full tree (Axis 1(b)), keeping
  the engine and the truth model aligned?
- Does any distributed ambition (multi-host) exist on the roadmap, or is local-first
  single-host a durable product stance? This bounds whether the substrate must ever
  leave single-writer JSONL at all.

## Related Docs

- Crash-safe durable substrate — `docs/research/decisions/crash-safe-durable-substrate.md`
- Inspect, replay, and recovery optimization — `docs/research/active/rfc-inspect-replay-and-recovery-optimization.md`
- Journey: inspect, replay, and recovery — `docs/journeys/operator/inspect-replay-and-recovery.md`
- Journey: WAL and crash recovery — `docs/journeys/internal/wal-and-crash-recovery.md`
