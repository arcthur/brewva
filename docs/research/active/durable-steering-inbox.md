# Durable Steering Inbox

## Metadata

- Status: active
- Implementation state: not started; open design question split out of the
  crash-safe substrate RFC.
- Owner: Gateway and runtime maintainers
- Last reviewed: `2026-06-22`
- Relates to:
  - [Decision: Crash-Safe Durable Substrate For Tape And Recovery WAL](../decisions/crash-safe-durable-substrate.md)
    (deferred this as its former "E")
  - [Journey: WAL And Crash Recovery](../../journeys/internal/wal-and-crash-recovery.md)
  - [Journey: Channel Gateway And Turn Flow](../../journeys/operator/channel-gateway-and-turn-flow.md)
- Promotion target:
  - `docs/journeys/internal/wal-and-crash-recovery.md`
  - `docs/journeys/operator/channel-gateway-and-turn-flow.md`
  - `docs/reference/runtime.md`

## Problem Statement

A managed session's in-session injections — steer, queue, and next-turn prompts —
live in memory only. `ManagedSessionDeferredTurnState` holds `#queuedPrompts`,
`#followUpPrompts`, and `#pendingNextTurnMessages` as private arrays; a crash
between enqueue and consume loses every unconsumed injection. The Recovery WAL
makes the **turn envelope** durable, but not these in-session messages: the window
between "user injected a steer mid-turn" and "the turn loop consumed it" is
unprotected.

Whether that window is worth durable storage is a real question, not a foregone
conclusion. This note exists to answer it deliberately rather than reflexively
reach for the WAL — because the obvious answer (reuse the WAL) carries a hidden
cost that the crash-safe substrate RFC declined to absorb.

## Scope Boundaries

In scope:

- decide **whether** the enqueue→consume window needs durable storage, and for
  which session classes;
- if it does, decide **where** that durability lives.

Out of scope:

- the substrate's crash-safety itself (atomic rewrite, fsync, torn-tail,
  quarantine) — that is the crash-safe substrate RFC;
- exactly-once delivery of the injected prompt (the model is `at_least_once`,
  consistent with the WAL);
- multi-writer / concurrent-session injection — that is the tree / multi-writer
  fork.

## Decision Options

### Option 1 — Re-home the inbox onto the Recovery WAL

Append each injection as a WAL row with a new source kind (`steer` / `followup` /
`nextturn`, `dedupeKey: promptId`), make the in-memory queue a projection of the
session's non-terminal rows, `markDone` on consume, and let the existing recovery
handler re-enqueue on restart.

- Pro: free recovery, replay, TTL, compaction, and one inspect surface
  (`recoveryWal`); reuses the `pending → inflight → done` lifecycle exactly.
- Pro: borrows opencode's durable admit→promote mechanism without its store.
- **Con (the load-bearing objection):** it widens the WAL's documented identity.
  The journey doc defines the WAL as the "ingress-acceptance and in-flight-turn
  log." A steer is not ingress — it is an in-session injection, a different
  ontological category with a different lifecycle (no upstream-redelivery
  decoupling to provide, a much shorter natural TTL, session-scoped not
  gateway-scoped). Folding it in makes the WAL also an "in-session steering log."
  That is precisely the silent-authority/identity widening axiom 14 guards
  against, and the crash-safe RFC's `+1 concept` budget did not cover it.

### Option 2 — A session-scoped steering sidecar

A small per-session durable log alongside the tape (e.g.
`.brewva/steering/<session>.jsonl`), reusing the same `rewriteFileAtomic` /
`loadAppendOnly` / quarantine helpers the substrate RFC introduces.

- Pro: keeps the WAL's identity clean; co-locates steering with the session it
  belongs to; inherits the substrate RFC's crash-safety primitives for free.
- Con: another durable log to operate, back up, and inspect; duplicates the
  lifecycle machinery the WAL already has.

### Option 3 — Do not persist the window

Accept that an unconsumed in-session injection is lost on crash.

- Pro: simplest; the **consumed** steer is already on the tape (truth), so only
  the live enqueue→consume window is at risk; for a present-user interactive
  coding session that window is short and the user can re-inject — pi-mono loses
  it and is perfectly usable.
- Con: autonomous, scheduled, or long-running sessions (no user present to
  re-inject) silently lose injected work; the loss is invisible.

## Source Anchors

- `packages/brewva-gateway/src/hosted/internal/session/managed-agent/deferred-dispatch.ts`
  — `ManagedSessionDeferredTurnState` (44); in-memory `#queuedPrompts` (45),
  `#followUpPrompts` (46), `#pendingNextTurnMessages` (47);
  `enqueueStreamingUserPrompt` / `consumeNextPromptBatch`;
  `restoreUnattemptedPromptBatch` (110) — already the in-memory "restore unconsumed"
  hook a projection would feed.
- `packages/brewva-gateway/src/daemon/recovery.ts` — `appendPending(envelope,
source, opts)` (the `source` parameter is the extension point for Option 1) and
  the `pending → inflight → done` lifecycle.
- External (mechanism, not authority):
  `/Users/bytedance/new_py/opencode/packages/core/src/session/sql.ts` @ `4ecc3ac65`
  — `SessionInputTable` (139), durable `admitted_seq` (149) / `promoted_seq` (150)
  with unique indexes (162–163): the admit→promote durability to borrow under
  `Borrow the mechanism, never the authority shape`.

## Hypotheses And Lean

1. The decision hinges on **session class**, not on a universal answer. Interactive
   present-user sessions tolerate Option 3; autonomous / scheduled / heartbeat
   sessions do not.
2. **Measure before building.** Instrument how often the enqueue→consume window is
   non-empty at process exit, split by session class. If it is rare and confined
   to interactive sessions, Option 3 wins outright.
3. If durability is warranted, **lean Option 2 over Option 1.** Steering is
   session-scoped, not gateway-ingress-scoped; a sidecar keeps the two-log
   distinction honest, where folding it into the WAL blurs it. Option 2 also costs
   little once the crash-safe substrate RFC has landed the shared helpers.

## Validation Signals

- An instrumentation pass: count non-empty enqueue→consume windows at exit by
  session class (the input to the decision).
- For whichever option is chosen, a crash-mid-turn test: enqueue a steer, kill the
  process before consume, restart, and assert the chosen contract — survival
  (Options 1/2) or a documented, surfaced loss (Option 3).

## Promotion Criteria

- A recorded decision among the three options, justified by the instrumentation.
- If Option 1 or 2: the journey doc gains the steering-durability contract and the
  source-kind / sidecar layout; `runtime.md` notes the recovery behavior.
- If Option 3: the journey doc states the window is intentionally non-durable for
  the named session classes, so the loss is documented rather than surprising.

## Open Questions

- Do non-prompt `nextTurn` custom messages (not user prompts) belong in any
  durable store, or are they always transient by nature?
- If Option 2, does the sidecar share the tape's session directory and lifecycle
  (created/removed with the session), and does it compact on the same horizon?

## Related Docs

- Crash-safe durable substrate — `docs/research/decisions/crash-safe-durable-substrate.md`
- Journey: WAL and crash recovery — `docs/journeys/internal/wal-and-crash-recovery.md`
- Journey: channel gateway and turn flow — `docs/journeys/operator/channel-gateway-and-turn-flow.md`
