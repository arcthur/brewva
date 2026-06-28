# Decision: Completing Cron Recurrence In The Event-Sourced Scheduler

## Metadata

- Decision: Recurring cron schedules are completed inside the existing event-sourced scheduler (the accepted `schedule-intent-hardening-and-control-plane-ergonomics` decision), not replaced by a new control-plane subsystem or sidecar job store. One shared `nextScheduleRunAt` helper (timezone/DST-correct cron next-slot plus deterministic forward jitter) is the single source of truth for both the projection and the daemon timer driver, and the computed `nextRunAt` is event-carried and authoritative under replay. A fired recurring intent settles every run — success or failure — by re-arming at the next slot via an `intent_rescheduled` event when `runCount < maxRuns`, or converging when no slot remains. The cron parser is extended past `MM HH * * *` so day-of-week, day-of-month, month, and `*/N` steps parse, making the shipped self-improve default `0 9 * * 1` valid.
- Date: `2026-06-28`
- Status: accepted
- Stable docs:
  - `docs/reference/configuration.md`
  - `docs/journeys/operator/intent-driven-scheduling.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/schedule.ts` (`nextScheduleRunAt`, `mergeScheduleSpec`, `parseCronExpression`, `getNextCronRunAt`)
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/schedule-projection.ts` (`listScheduleIntentRows`)
  - `packages/brewva-gateway/src/daemon/recovery.ts` (`createSchedulerService`: `upsertIntent`, `fireIntent`, `armIntent`, `intent_rescheduled`)
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/schedule.ts` (`buildScheduleRuntimeOps`)

## Decision Summary

- This completes, not supersedes, `schedule-intent-hardening-and-control-plane-ergonomics`. A disciplined read found that decision partly aspirational: `getNextCronRunAt` was timezone/DST-correct but had no caller, so both read models armed cron intents at a `timestamp + 60_000` placeholder and never re-armed after a fire — a `0 9 * * *` intent did not recur. A new scheduler subsystem, sidecar job store, cron library, or parent-session dispatch injection was rejected as redundant with the event-sourced child-session design.
- Jitter is deterministic from the intent id (a capped fraction of the cron interval), so replaying the same intent yields the same `nextRunAt`; the event carries the value and replay never recomputes from wall-clock. The projection and the daemon driver prefer a persisted `nextRunAt` and extract the derive-time spec through one shared `mergeScheduleSpec`, so a partial update omitting `cron`/`runAt` re-derives from the retained spec and the two read models cannot drift.
- The continuing run emits `intent_rescheduled` (kept active, fresh `nextRunAt`), never `intent_converged` — `statusFor` maps converged to terminal unconditionally, which previously double-broke recurrence. A failed run settles the same way (advances and re-arms, error recorded) so a transient failure does not silently end a recurring schedule; the attempt is counted once on `intent_fired`. `armIntent` chunks delays beyond the signed 32-bit `setTimeout` ceiling so a far-future slot no longer fires immediately.
- Cron expressivity is extended to a bounded per-field grammar (`*`, single literal, `*/N` step; day-of-week with `7` meaning Sunday; day-of-month/month under Vixie OR semantics) — every form the product emits, not a general cron grammar.
- Zero new surface: no new authored field, config key, persisted schema, or routing decision point. `nextRunAt` was already a field on the `schedule.intent` event, and this populates it correctly.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- Obeys `Tape is commitment memory` (axiom 6): the computed `nextRunAt` is carried on the `intent_created` and post-fire `intent_rescheduled` events and is authoritative under replay; the scheduler never recomputes the next slot from wall-clock during rebuild.
- Obeys `Product loops are projections, not runtime state machines` (axiom 12): recurrence stays a projection over `schedule.intent` receipts plus a daemon timer driver computing from one shared helper, not a new runtime state machine or scheduler subsystem.

## Open follow-ups

- The deferred safety pass — leases (`leaseDurationMs`), circuit-breaking (`maxConsecutiveErrors`), recovery catch-up bounds (`maxRecoveryCatchUps`), stale one-shot deferral (`staleOneShotRecoveryThresholdMs`) — plus convergence-predicate evaluation and durable projection persistence remain config-only with no consumer; they belong to a separate hardening note, not this contract.
- Open questions left to that note: whether `maxJitterMs` becomes configurable, the cron expressivity ceiling (ranges/lists beyond the current grammar), and a config-time hard reject of an unparseable cron (today it fails safe by declining to arm, and the self-improve default is test-guarded).
