# Decision: Tree History And Multi-Writer Substrate

## Metadata

- Decision: Brewva keeps linear-append + replay as its history model with an additive event `parentId` as the append-only branching hook, and stays single-writer-per-session as the deliberate end-state. Sub-agent shared history is served by per-session isolation + a cross-session `parentSessionId`, not a multi-writer shared log; a multi-writer-with-CAS substrate is deliberately not built.
- Date: `2026-06-24`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/journeys/internal/wal-and-crash-recovery.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime-api.ts` (`CanonicalEvent.parentId`)
  - `packages/brewva-runtime/src/runtime/tape/impl.ts` (per-session leaf + parent default)
  - `packages/brewva-vocabulary/src/internal/delegation.ts` (`parentSessionId`)
  - `packages/brewva-session-index/src/projection/delegation.ts` (child to parent result projection)

## Decision Summary

- Axis 1 (history shape): stay linear + replay. An event `parentId` is the additive, nullable, projection-tolerant hook for structural branching (implemented); navigating or forking a branch is the replay engine's concern (the inspect-replay RFC), not the tape's.
- Axis 2 (writer model): single-writer-per-session is the deliberate end-state, not a stopgap. One append-only log with one writer is what makes the tape replayable, auditable, and crash-safe — brewva's hardest asset. A multi-writer shared log would trade that for merge ambiguity, CAS, and concurrency bugs.
- Sub-agent shared history is already satisfied without a substrate change: delegation gives each delegated turn its own session id and tape (per-session isolation), linked by `parentSessionId` + a `session_root` event, with the delegation projection carrying the by-value result merge-back. This is isomorphic to all four surveyed peers (pi-mono, hermes, opencode, claude-code), none of which use a multi-writer shared log for sub-agent history.
- A multi-writer-with-CAS substrate (per-writer logs / write coordinator / concurrent append / revision + CAS) is NOT built. The only trigger is multi-host distribution writing one logical history — unproven on the roadmap, so axiom 3 says do not pre-build. Even then the shape is single-writer-per-session plus a selective lease on the one truly-conflicting operation (as hermes does for compaction), not a full multi-writer rewrite.
- A cross-session lineage view (unifying the event `parentId` and the session `parentSessionId` into one navigable tree) belongs to the inspect-replay RFC, requirement-triggered, not here.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- Obeys `Subtraction beats switches` (axiom 3): the multi-writer substrate is not pre-built; single-writer + parent pointer is the smaller, sufficient mechanism, and a selective lease is added only if multi-host distribution lands.
- Obeys `Tape is commitment memory` (axiom 6): one append-only, single-writer log per session keeps the tape the single auditable replay authority; a multi-writer shared log would dissolve the single truth-writer.
- Obeys `Same evidence is not shared authority` (axiom 11): sub-agent history stays a per-session surface linked by a parent pointer, rather than collapsing distinct writers into one shared log.

## Open follow-ups

- `parentId` linearity holds only under the single-writer-per-session invariant: `commit` defaults the parent to the writer's local leaf, which equals the file tip precisely because one writer owns the session. An explicit `parentId` is stored unverified (a fork may legitimately reference an ancestor not in this instance's memory), so the replay engine must tolerate — and may repair — a dangling parent edge.
- If multi-host distribution becomes a roadmap requirement, revisit Axis 2 — the addition is a selective cross-process lease over single-writer sessions, not a multi-writer log. The cross-session lineage view is tracked by the inspect-replay RFC.
