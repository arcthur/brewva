# RFC: Completing Cron Recurrence In The Event-Sourced Scheduler

> Scope corrected after a disciplined read (2026-06-27). The original draft
> proposed a new control-plane scheduler subsystem with its own sidecar job store.
> That is rejected: brewva scheduling is already event-sourced under the accepted
> decision `schedule-intent-hardening-and-control-plane-ergonomics.md`
> (`follow_up` / `schedule_intent` events are the durable source of truth, "not a
> separate scheduler subsystem"). The real residue is that the existing scheduler
> is stubbed against its own decision — most importantly, recurring cron schedules
> do not actually recur. This RFC completes that, it does not replace it.

## Metadata

- Status: active
- Owner: Gateway scheduler, runtime config, and vocabulary maintainers
- Last reviewed: `2026-06-27`
- Depends on:
  - [RFC: Inspect, Replay, And Recovery Optimization](./rfc-inspect-replay-and-recovery-optimization.md)
- Promotion target:
  - `docs/reference/configuration.md`
  - `docs/journeys/operator/intent-driven-scheduling.md`

## Problem Statement

brewva already has an event-sourced scheduler: `schedule_intent` (and the
`follow_up` ergonomic wrapper) emit `schedule.intent` events that are the durable
source of truth; a projection rebuilds intent state; a daemon timer driver arms a
`setTimeout` per active intent and runs a child session on fire. The accepted
decision `schedule-intent-hardening-and-control-plane-ergonomics.md` fixes this
shape and additionally claims forward-jittered cron `nextRunAt`, stale one-shot
recovery deferral, leases, and circuit-breaking — but its `Code anchors: N/A`
already signals the decision is partly aspirational.

A disciplined read of the code confirms a large decision-vs-code drift. The
keystone is a correctness bug, not a missing feature:

1. **Recurring cron schedules do not recur on their schedule.** `getNextCronRunAt`
   exists and is timezone/DST-correct, but it has **no caller** anywhere. Both the
   projection and the daemon driver set a cron intent's `nextRunAt` to a fixed
   `timestamp + 60_000` placeholder (`schedule-projection.ts` `listScheduleIntentRows`;
   `recovery.ts` `createSchedulerService` `upsertIntent`). A `0 9 * * *` intent
   does not fire daily at 09:00 — it is armed 60 seconds out.
2. **A fired intent is never re-armed within a running daemon.** `fireIntent`
   emits an `intent_converged` event but does not call `armIntent`; the timer was
   already deleted before firing. A recurring intent only re-arms on the next
   `recover()` (daemon restart), so in steady state it fires once and stops.
3. **No forward-jitter** on `nextRunAt`, though the decision claims deterministic
   jitter and replay treating the event-carried `nextRunAt` as authoritative.
4. **Cron expressivity is `MM HH * * *` only.** `parseCronExpression` rejects any
   non-`*` day-of-month, month, or day-of-week — so the shipped self-improve
   default `cron: "0 9 * * 1"` (Monday) fails to parse (`defaults.ts`). The
   default is latent (self-improve is off by default), but it is a real bug.

The framing line:

> The scheduler already remembers what to run and when it last ran. It just never
> learned to compute the next time. Teach it the clock it already owns.

## Scope Boundaries

In scope (make recurring cron actually work, end to end):

- a single source-of-truth helper that computes a cron intent's next `nextRunAt`
  from `getNextCronRunAt` plus a deterministic forward-jitter, replacing the two
  `+ 60_000` placeholders
- persisting the computed `nextRunAt` on the `intent_created` and post-fire
  `intent_converged`/recurrence events, so replay treats it as authoritative (the
  decision's stated contract)
- re-arming a recurring intent after a fire when `runCount < maxRuns`
- extending `parseCronExpression` to support day-of-week (and day-of-month/month)
  so `0 9 * * 1` parses; fixing or validating the self-improve default against it
- keeping the projection and the daemon driver computing `nextRunAt` from one
  shared helper so the two read models cannot drift

Out of scope (real, decided-but-unimplemented, owned by a separate hardening note):

- leases (`leaseDurationMs`), circuit-breaking (`maxConsecutiveErrors`), recovery
  catch-up bounds (`maxRecoveryCatchUps`), stale one-shot deferral
  (`staleOneShotRecoveryThresholdMs`) — all config-only today with no consumer;
  they are a coherent safety pass of their own → `Open Questions` / follow-up note
- convergence-predicate evaluation (`convergenceCondition`) — accepted by the tool,
  never evaluated; a separate deliberation-layer concern
- durable projection persistence (`getProjectionPath` is `null`; `projectionPath`
  config unused) — the projection is rebuildable from events, so this is a
  recovery-latency optimization, not a correctness gap; deferred
- a new scheduler subsystem, a sidecar job store, `croner`, or deferred-dispatch
  injection into the parent session — **rejected**: redundant with and contrary to
  the event-sourced, child-session design fixed by the accepted decision
- result delivery to an operator channel — the existing design runs a child
  session observable via `schedule.*` events and inspect; channel delivery is a
  separate product decision, not part of fixing recurrence

## Peer Lens: What `hermes`'s `cron/` Subsystem Gets Right

Verdict vocabulary: **COVERED**, **REJECT**, **BORROW**, **OUT OF SCOPE**.

| `hermes` mechanism                                 | Verdict       | Rationale / where it lands                                                                                                            |
| -------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| durable `jobs.json` job store                      | COVERED       | `schedule.intent` events are the durable store (accepted decision). A sidecar would be redundant and is rejected.                     |
| `croniter` next-due computation                    | COVERED       | brewva already has `getNextCronRunAt` (TZ/DST-correct). The bug is that it is unused — wire it, do not add `croner`.                  |
| broad cron expressivity (dow, dom, ranges, steps)  | BORROW (thin) | Extend the in-repo `parseCronExpression` to day-of-week at minimum so `0 9 * * 1` parses. Stay zero-dep; do not adopt a cron library. |
| forward-jitter to avoid thundering-herd recurrence | BORROW        | The decision already claims it; implement a deterministic jitter so replay stays authoritative.                                       |
| deliver output to any platform                     | OUT OF SCOPE  | Child-session + events is the existing observability model; channel delivery is a separate decision.                                  |
| fire-time prompt-injection scan                    | OUT OF SCOPE  | A real safety concern, but it belongs with the lease/circuit hardening pass, not the recurrence fix.                                  |
| batch / multi-task runs                            | REJECT        | Exceeds the stable `single tool call` boundary (axiom 17); one intent, one child turn.                                                |

The honest residue from the peer is small because brewva already chose the
stronger event-sourced design — it just left the cron math unwired.

## Decision Options

### A. One shared `nextRunAt` helper (chosen)

Add a pure helper (home: `@brewva/brewva-vocabulary` schedule module, beside
`getNextCronRunAt`, since both projection and daemon already import schedule
vocabulary) that, given an intent's `cron`/`timeZone`/`runAt` and a `from` time,
returns the next `nextRunAt` with deterministic forward-jitter. Both
`listScheduleIntentRows` (projection) and `createSchedulerService` (daemon) call
it instead of the `+ 60_000` placeholder, so the two read models compute identical
times and cannot drift.

Jitter is deterministic from the intent id (e.g. a hash of `intentId` mapped into
`[0, maxJitterMs)`), so replaying the same intent yields the same `nextRunAt` —
honoring the decision's "replay treats the event-carried `nextRunAt` as
authoritative." The event carries the computed value; replay never recomputes from
wall-clock.

### B. Settle after fire — re-arm or converge (chosen)

`fireIntent` settles every run, success OR failure, through one path: with
`runCount < maxRuns` it computes the next `nextRunAt` via the shared helper and
re-arms the timer; otherwise (no next slot, e.g. a one-shot or `runCount >= maxRuns`)
it converges. This makes a running daemon honor recurrence without waiting for a
restart. "Recurrence" is bounded by `maxRuns` (default `1`); a continuously
recurring cron intent is one whose `maxRuns` is set high — there is no unbounded
recurrence, by design.

A failed run settles the SAME way: it advances to the next slot and re-arms (with
the error recorded on the event for inspection), rather than leaving the intent
active at the just-fired past slot with no timer — which would silently end
recurrence in-process and re-fire immediately on every restart. Circuit-breaking
(stop after K consecutive failures) is the deferred safety pass; until it lands, a
transient failure must not kill a recurring schedule.

Implementation note (discovered during the build): the continuing run must emit a
new `intent_rescheduled` event kind, not `intent_converged`. `statusFor` maps
`intent_converged` to a terminal status unconditionally, so the prior code's
`status: "active"` on a converged event was silently overridden — recurrence was
doubly broken (no re-arm AND forced-terminal). `intent_rescheduled` keeps the
intent active and carries the fresh `nextRunAt`; `intent_converged` is reserved for
true termination. The run attempt is counted once on the `intent_fired` event, so
the settle path (success or failure) never re-increments `runCount`.

A second discovered fix: `armIntent` must chunk delays beyond the signed 32-bit
millisecond `setTimeout` ceiling (~24.8 days). A far-future slot (e.g. the
`0 0 1 1 *` yearly self-improve schedule, ~188 days out) previously overflowed and
fired immediately; it now re-arms in capped chunks until the remainder fits.

Both read models (projection and daemon driver) prefer a persisted `nextRunAt` and
extract the derive-time spec through one shared `mergeScheduleSpec(input, previous)`
helper (input overrides prior fields), so a partial update that omits the schedule
fields re-derives from the retained spec rather than wiping it. They agree on every
intent the system writes; a legacy event lacking a persisted value derives
independently and may differ only by the display-vs-arming clock reference.

### C. Cron expressivity extension (chosen, bounded)

Extend `parseCronExpression` and `getNextCronRunAt` to support day-of-week (the
field the self-improve default needs), and day-of-month/month as bounded literal
or `*` fields. Keep it a small, well-tested extension of the existing zero-dep
parser — not a general cron grammar — and pin the self-improve default to a value
the parser accepts (and add a fitness/normalize check so a config cron that cannot
parse fails loudly rather than silently arming 60s out).

## Landing Plan

Three phases, each independently shippable, reversible, and reviewed before the
next begins (all three landed):

1. **Recurrence engine (pure, tested).** (Done.) Added the shared `nextScheduleRunAt`
   helper (cron + deterministic interval-relative jitter matching the established
   `computeExpectedRecurringJitteredNextRunAt` contract) in the schedule vocabulary
   module, with contract tests against golden times across a DST boundary and a
   jitter-determinism test. Pure function, zero behavior change.
2. **Wire recurrence + re-arm.** (Done.) Replaced both `+ 60_000` placeholders with
   the helper; `fireIntent` settles every run — success OR failure — by re-arming at
   the next slot via the new `intent_rescheduled` kind, or converging when none
   remains (a failure records its error but still advances, since circuit-breaking is
   deferred). `nextRunAt` is persisted on the `intent_created` event (capability layer)
   and on the post-fire event, so both read models prefer the same authoritative value;
   when they must derive it, both extract the MERGED spec through one shared
   `mergeScheduleSpec(input, previous)` helper, so a partial update that omits
   `cron`/`runAt` re-derives from the retained spec instead of wiping it. The two read
   models therefore agree on every system-written intent and differ only on a legacy
   value-less event by the display-vs-arming clock. A recurring `0 9 * * *` intent now
   fires on schedule and re-arms in a running daemon. Contract tests cover arm / re-arm /
   failed-run-advances / one-shot-converge / far-future chunking / create-persist /
   partial-update-preserve.
3. **Cron expressivity + far-future arming.** (Done.) Extended the parser and
   `getNextCronRunAt` to a general per-field grammar (`*`, literal, `*/N` step;
   day-of-week with `7`→Sunday; day-of-month/month with Vixie OR semantics) so every
   form the product emits parses — `*/5 * * * *`, `0 */2 * * *`, the self-improve
   default `0 9 * * 1`, and `0 0 1 1 *`. The default needed no pinning once the
   parser supports day-of-week; a contract test asserts the shipped default parses.
   `armIntent` now chunks delays past the 32-bit `setTimeout` ceiling. A hard
   config-time reject of an unparseable cron is deferred — unparseable crons fail
   safe (no arm) and the default is test-guarded.

## Source Anchors

- Cron parse + TZ-correct next-run (exists; `getNextCronRunAt` currently unused):
  `parseCronExpression`, `getNextCronRunAt`, `normalizeTimeZone` in
  `packages/brewva-vocabulary/src/internal/schedule.ts` (re-exported via
  `packages/brewva-vocabulary/src/schedule.ts`)
- Placeholder `+ 60_000` in the projection: `listScheduleIntentRows` in
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/schedule-projection.ts`
- Placeholder `+ 60_000` and the no-re-arm `fireIntent` in the daemon driver:
  `createSchedulerService` (`upsertIntent`, `fireIntent`, `armIntent`) in
  `packages/brewva-gateway/src/daemon/recovery.ts`
- Capability layer (emits events, projects): `buildScheduleRuntimeOps` in
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/schedule.ts`
- Self-improve default cron `0 9 * * 1` (currently unparseable):
  `packages/brewva-runtime/src/config/defaults.ts`
- Schedule config normalize (where a parse guard would land):
  `packages/brewva-runtime/src/config/normalize-schedule.ts`
- Existing cron/TZ test to extend:
  `test/contract/runtime/schedule-cron-timezone.contract.test.ts`
- Accepted decision this RFC completes (does not supersede):
  `docs/research/decisions/schedule-intent-hardening-and-control-plane-ergonomics.md`
- Peer precedent (read-only, external repo): `hermes`'s `cron/` (`croniter`
  next-due, jittered recurrence)

## Validation Signals

- Phase 1: `nextScheduleRunAt("0 9 * * *", { from, timeZone })` returns the next
  09:00 local across a DST spring-forward/fall-back; jitter is within
  `[0, maxJitterMs)` and identical for the same `intentId` across calls (replay
  determinism); a one-shot `runAt` is returned unchanged.
- Phase 2: a recurring cron intent's projected `nextRunAt` equals the helper's
  output (not `timestamp + 60_000`); after a fire with `runCount < maxRuns`, the
  daemon re-arms at the next cron time; a `maxRuns`-exhausted intent does not
  re-arm; the projection and daemon compute the same `nextRunAt` for the same
  events.
- Phase 3: `parseCronExpression("0 9 * * 1")` is `ok`; the self-improve default
  parses; an unparseable config cron is rejected by normalize/fitness rather than
  silently arming 60s out.

## Surface Budget

Counts are for the scheduler surface only; before → after.

- required authored fields: 0 → 0. No new model-facing or operator-authored field;
  `cron`/`timeZone`/`maxRuns` already exist on `schedule_intent`.
- optional authored fields: 0 → 0.
- author-facing concepts: +0. Recurrence is the already-documented behavior of an
  existing concept, now made real.
- inspect surfaces: +0 (the schedule projection already renders `nextRunAt`; it
  becomes correct).
- routing/control-plane decision points: +0. The fire/arm decision points already
  exist; this corrects what time they compute, not whether a turn may commit.
- config keys: +0 (extends the meaning of existing `schedule.*` and `cron`); a
  parse guard reuses existing normalize.
- persisted formats: +0 new schemas. `nextRunAt` is already a field on the
  `schedule.intent` event; this populates it correctly.
- net required authored fields: 0. debt owner: gateway scheduler maintainers.
  re-evaluation trigger: taking on the deferred safety pass (lease, circuit-breaker,
  catch-up, stale deferral) or convergence evaluation — each its own note.

The entire RFC lands as a correctness fix to existing fields and decision points:
it makes recurring cron schedules recur, with zero new surface.

## Promotion Criteria And Destination Docs

Promote a phase only when its validation signals pass against a green
`bun run check` and the full suite.

- `nextRunAt` recurrence/jitter contract → `docs/reference/configuration.md`.
- Recurrence and cron-expressivity behavior →
  `docs/journeys/operator/intent-driven-scheduling.md`.

On acceptance, fold these closures into the existing
`schedule-intent-hardening-and-control-plane-ergonomics.md` decision (adding the
now-real code anchors) rather than creating a competing decision.

## Open Questions

- Jitter window: what `maxJitterMs` (and is it configurable)? A daily cron wants a
  few minutes of jitter; a minutely cron wants near-zero. Default proposed: a small
  fixed cap, intent-id-deterministic.
- Cron expressivity ceiling: day-of-week is required (self-improve); are ranges
  (`1-5`), lists (`1,3`), and steps (`*/2`) in scope now, or only single literals
  and `*`? Default proposed: single literal or `*` per field in this RFC; ranges/
  steps as a follow-up if a real schedule needs them.
- Self-improve default: pin to a parser-supported `0 9 * * 1` once day-of-week
  lands, or change the default cadence? Prefer: land day-of-week so the documented
  default works as written.
- The deferred safety pass (lease/circuit/catch-up/stale) and convergence
  evaluation: one combined hardening note, or separate? They share the daemon
  driver but are independent behaviors.

## Related Work

- The accepted decision this RFC completes (not supersedes):
  `schedule-intent-hardening-and-control-plane-ergonomics.md`.
- The operator journey describing the intended (currently partly-unimplemented)
  behavior: `docs/journeys/operator/intent-driven-scheduling.md`.
- Opt-in control-plane growth discipline: axiom 17.
- Receipt discipline for every fire: axiom 5 (the `schedule.*` events).
