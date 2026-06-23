# Decision: Durable Steering Inbox

## Metadata

- Decision: Deferred user-prompt injections (steer / queue / follow-up) are made durable in a per-session steering sidecar, not by widening the Recovery WAL. Injections persist on enqueue and are tombstoned on consume; a restart rebuilds the unconsumed queue. Next-turn custom messages are advisory transient context and are not persisted.
- Date: `2026-06-23`
- Status: accepted
- Stable docs:
  - `docs/journeys/internal/wal-and-crash-recovery.md`
  - `docs/journeys/operator/channel-gateway-and-turn-flow.md`
  - `docs/reference/runtime.md`
  - `docs/reference/artifacts-and-paths.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/steering-sidecar.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/deferred-dispatch.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`

## Decision Summary

- Option 2 (a session-scoped sidecar) was chosen over Option 1 (re-home onto the Recovery WAL) and Option 3 (do not persist). Option 1 was rejected because it widens the WAL's documented identity from an ingress-acceptance log into an in-session steering log — the silent identity-widening the axiom-14 guard forbids. Option 3 was rejected because autonomous / scheduled sessions lose injected work invisibly.
- The sidecar lives at `.brewva/steering/<encodeURIComponent(sessionId)>.jsonl` and reuses the crash-safe substrate's primitives (`appendFileDurable` / `loadAppendOnly`); it is deliberately minimal (append a row on enqueue, a tombstone on consume, replay survivors on restart), with no compaction, TTL, retry, or watermark — an in-session injection needs none. A malformed or torn line is skipped on load, so one bad line never wedges restart recovery.
- Only the two user-prompt channels (queue / followUp) are persisted. A next-turn custom message is advisory turn context injected into the next provider call (never a tape event of its own) and is held in memory only — persisting it would have to tombstone it before its turn runs, breaking `at_least_once`, and it carries no user input worth recovering. The record payload is opaque JSON (the prompt's content parts); the integration layer serializes it with `toJsonValue` and rebuilds it by channel.
- A prompt is durably retired only after its turn returns (success, stopped, or throw), so a crash inside the enqueue->consume window re-enqueues it on restart rather than losing it — `at_least_once`, consistent with the WAL.
- Durability is unconditional for managed sessions (no session-class branch, no config switch); steering is low-frequency, so the per-injection fsync cost is negligible.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- Obeys `Same evidence is not shared authority` (axiom 11) and the identity guard behind `Documentation hierarchy follows authority hierarchy` (axiom 14): steering stays a session-scoped surface instead of widening the gateway-ingress WAL's identity.
- Obeys `Graceful degradation beats hidden cleverness` (axiom 8): a torn or malformed sidecar line self-heals or is skipped (never wedges restart), and an unconsumed injection re-enqueues rather than vanishing.
- Obeys `Recovery is model-native, not kernel choreography` (axiom 10): the sidecar is a durable primitive (append + restore), not a steering planner or second session lifecycle.

## Open follow-ups

- Compaction is intentionally omitted: the per-session file is short-lived and low-frequency, so unbounded growth is not a concern in practice. If a long-running session's sidecar is ever observed to grow problematically, add a compaction pass (e.g. on a successful full drain) at that point — not before.
