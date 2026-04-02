# Research: Schedule Intent Hardening and Control-Plane Ergonomics

## Document Metadata

- Status: `promoted`
- Owner: runtime/gateway maintainers
- Last reviewed: `2026-04-02`
- Promotion target:
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events.md`
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/reference/tools.md`
  - `docs/reference/commands.md`
  - `docs/journeys/operator/intent-driven-scheduling.md`

## Promotion Summary

This research note is now a promoted status pointer.

The promoted decision is:

- recurring cron-backed schedule intents persist deterministic forward-jittered
  `nextRunAt` values, and replay treats the event-carried timestamp as
  authoritative
- stale one-shot recovery is deferred by explicit policy rather than always
  firing on catch-up
- gateway exposes an explicit daemon-local `scheduler.pause` /
  `scheduler.resume` incident-control latch
- `follow_up` exists as a bounded structured wrapper above
  `schedule_intent`; the stable tool contract uses `after` / `every` duration
  selectors rather than a free-form natural-language parser

Stable references:

- `docs/reference/runtime.md`
- `docs/reference/configuration.md`
- `docs/reference/events.md`
- `docs/reference/gateway-control-plane-protocol.md`
- `docs/reference/tools.md`
- `docs/reference/commands.md`
- `docs/journeys/operator/intent-driven-scheduling.md`

## Direct Conclusion

Brewva should harden its replay-first scheduling model in four focused ways
without widening kernel authority or reintroducing hidden cognition-driven
automation:

1. add deterministic forward jitter for recurring cron-backed schedule intents,
   and persist the jittered `nextRunAt` as authoritative schedule state
2. add a bounded `follow_up` wrapper that compiles into `schedule_intent`
   instead of asking ordinary users to author raw cron-oriented calls
3. defer stale one-shot recovery runs instead of always firing them
   automatically during scheduler recovery
4. add an explicit gateway control-plane pause/resume surface for schedule
   execution

This RFC does **not** recommend adding a memory-only branch inside
`runtime.schedule.*`.

If Brewva later needs transient reminders that intentionally die with the
daemon process, that should be modeled as a gateway/control-plane trigger lane,
not as a second non-replayable flavor of schedule intent.

## Problem Statement And Scope

Brewva's current schedule system is architecturally sound:

- `schedule_intent` events are the durable source of truth
- the on-disk schedule projection is rebuildable rather than authoritative
- recovery is replay-first and WAL-aware
- scheduled runs execute through explicit wake-up prompts and child-session
  boundaries

That architecture should remain intact.

The current implementation still has four practical gaps.

### Problem 1: recurring cron intents still converge on exact wall-clock boundaries

`SchedulerService.computeCronNextRunAt(...)` currently returns exact boundary
times.

That means many intents such as `0 9 * * *` or `*/5 * * * *` will arm for the
same instant and then compete for:

- child-session creation
- worker capacity
- model API throughput
- control-plane queue space

This is a scheduler load-shaping problem, not a replay problem.

### Problem 2: the canonical schedule surface is too heavy for routine user intent

`schedule_intent` is designed correctly for precision and auditability, but its
current call shape is optimized for the kernel contract rather than ordinary
interactive use.

Typical user intent such as:

- "check this again in 20 minutes"
- "run this every 5 minutes for the next hour"
- "follow up tomorrow morning"

should not require direct authoring of:

- `action`
- raw cron strings
- `continuityMode`
- `maxRuns`
- recovery-oriented fields

### Problem 3: stale one-shot recovery is too eager

During recovery, Brewva currently catches up due intents according to
`nextRunAt`.

That behavior is correct for recurring follow-up work and for bounded retry
loops, but it is too eager for stale one-shot reminders.

The risk is not "unauthorized execution" because side effects still cross the
existing tool gate and `effect_commitment` boundary.

The real risk is intent drift:

- the wake-up may still be valid operationally
- but the user's original timing assumption may no longer hold

### Problem 4: there is no immediate operator pause surface for schedule execution

`schedule.enabled` is a configuration contract, not an active control-plane
latch.

Operators currently have no explicit gateway method for:

- pausing new schedule firings
- pausing recovery catch-up
- resuming execution after an incident or queue-pressure event

That is an operational ergonomics gap, not a kernel-model gap.

## In Scope

- recurring cron jitter for replay-safe schedule execution
- a user-facing follow-up wrapper that compiles to `schedule_intent`
- stale one-shot recovery deferral policy
- explicit gateway pause/resume controls for schedule execution
- test and documentation changes needed to keep the new semantics legible

## Out Of Scope

- changing the proposal boundary
- changing `effect_commitment` semantics
- changing child-session isolation for scheduled runs
- changing heartbeat triggers into hidden or cognition-driven automation
- introducing a memory-only schedule-intent subtype inside `runtime.schedule.*`
- replacing `schedule_intent` as the canonical runtime-facing contract
- introducing SaaS-style remote feature-flag infrastructure for scheduler tuning

## Goals

- preserve replay-first schedule authority
- reduce thundering-herd behavior for recurring cron workloads
- improve user-facing schedule ergonomics without weakening the canonical
  runtime contract
- make stale one-shot recovery more faithful to user intent
- give operators an immediate, explicit pause surface

## Non-Goals

- do not make scheduling "smarter" by inserting a hidden model-owned wake
  suppression layer
- do not add a planner-shaped autonomous loop to the runtime
- do not create a second schedule truth model that bypasses event replay
- do not redesign heartbeat policy and schedule intent into one merged concept
  in the first pass

## Decision Options

### Option A: keep the current schedule system unchanged

Pros:

- no migration work
- keeps the current contract simple

Cons:

- preserves exact-time herd behavior for recurring cron workloads
- keeps the user-facing schedule path unnecessarily heavy
- continues to auto-fire stale one-shot recovery runs
- leaves operators without a real-time pause surface

### Option B: add ad hoc fixes at the timer and prompt layers only

Examples:

- inject jitter only when arming timers
- make the tool prompt more descriptive
- tell operators to restart the daemon when they need a pause

Pros:

- low short-term cost
- minimal public discussion

Cons:

- creates timer/projection drift for jittered execution
- leaves ergonomics dependent on prompt luck instead of a deterministic wrapper
- treats operational pause as a process-control workaround
- does not produce a coherent scheduling posture

### Option C: harden the schedule path while preserving replay-first authority

Pros:

- keeps `schedule_intent` authoritative
- adds load-shaping without hidden runtime forks
- improves user-facing ergonomics at the wrapper layer
- makes stale recovery and operator pause explicit

Cons:

- requires coordinated runtime, gateway, tool, and docs updates
- adds a small amount of policy surface that must be documented carefully

### Recommended Option

Choose **Option C**.

## Recommended Design

## Part 1: Deterministic recurring jitter with authoritative `nextRunAt`

### Decision

Apply deterministic forward jitter to recurring cron-backed schedule intents and
persist the resulting `nextRunAt` as authoritative schedule state.

### Why the jitter result must become durable schedule state

Brewva recovery and catch-up logic reason over projection state derived from
`schedule_intent` events.

If jitter exists only in `armTimer(...)`, the runtime would create two
different notions of due time:

- replay/projection due time
- actual execution due time

That split is avoidable and undesirable in a replay-first scheduler.

### Scope

V1 should apply jitter only to:

- intents with `cron`
- intents that remain `active`
- recurring follow-up execution

V1 should **not** jitter:

- explicit `runAt` one-shot intents
- recovery deferrals
- manual operator reschedules

### Shape

- use a stable hash derived from `intentId`
- compute a deterministic fraction in `[0, 1)`
- convert that fraction into a bounded forward delay
- apply the delay when producing the next `nextRunAt`
- persist the jittered `nextRunAt` through the existing
  `intent_created` / `intent_updated` / `intent_fired` event flow

### Replay and historical determinism

Replay must treat the event-carried `nextRunAt` as authoritative whenever it is
present.

That means:

- create/update/fire paths should write the jittered `nextRunAt`
- `applyScheduleEvent(...)` should continue to prefer the persisted event
  value over recomputation
- fallback recomputation should exist only for legacy event shapes or missing
  `nextRunAt` payloads

This keeps replay deterministic even if the jitter policy changes later.

### Initial policy

V1 should keep the policy intentionally narrow:

- fraction-based forward jitter for recurring cron
- bounded by an implementation constant or tightly scoped schedule config
- no remote tuning system

If later operational evidence shows a need for public tuning knobs, that should
be a follow-on change with explicit config and operator documentation.

## Part 2: Follow-up wrapper over `schedule_intent`

### Decision

Add a user-facing wrapper surface that compiles into `schedule_intent` rather
than widening the canonical schedule contract itself.

### Rationale

The current `schedule_intent` shape is correct for the runtime boundary.
It is not the right primary authoring surface for casual follow-up requests.

Brewva should preserve the explicit runtime contract while adding a thinner
experience-ring compiler above it.

### Recommended surface

V1 introduces a wrapper surface named `follow_up`.

The stable wrapper contract is intentionally narrow:

- `create`, `cancel`, and `list`
- `after` duration strings for one-shot follow-ups
- `every` duration strings for bounded recurring follow-ups
- default `continuityMode=inherit`
- bounded recurring defaults instead of exposing unbounded recurrence
- `schedule_intent` remains available as the precise lower-level surface

Client-side aliases such as `/loop` may exist, but they should compile into the
structured `follow_up` contract rather than creating a second parser or a
second scheduling model inside the runtime.

### Non-goal

The wrapper should not invent a second durable schedule model.
It is a compiler into the existing runtime-facing contract.

## Part 3: stale one-shot recovery deferral

### Decision

Recovery should distinguish between:

- recurring due work
- normal recent one-shot work
- stale one-shot work

Only the third class should be deferred by policy.

### Current behavior that this RFC intends to change

`catchUpMissedRuns()` currently defers only two classes of due work:

- intents whose prior schedule turn is still `inflight` in the turn WAL
- intents that overflow `maxRecoveryCatchUps`

All other due intents currently flow through the same `allDue -> due -> toFire`
path regardless of whether they are:

- a long-stale one-shot `runAt` reminder
- a recently due recurring cron follow-up

That means a three-day-old one-shot and a five-minute-old recurring wake-up are
currently treated as the same recovery class as long as they both satisfy
`nextRunAt <= now`.

### Recommended policy

For intents that satisfy all of the following:

- `runAt` is present
- `cron` is absent
- recovery time is meaningfully later than `runAt`

the scheduler should defer the intent instead of firing it immediately.

The defer path should reuse the existing `schedule_recovery_deferred` telemetry
family rather than introducing a new recovery mechanism.

### Implementation anchor

This should not be implemented as a fourth scheduler mechanism.

The intended change is a classification refinement inside
`SchedulerService.catchUpMissedRuns()`:

- keep the existing `deferredByWal` classification
- keep the existing `overflow` classification
- add a third defer source for stale one-shot intents discovered during the
  current `allDue` / `due` filtering path

Concretely, the classification should happen after "is this due?" but before
the intent enters the round-robin `toFire` queue:

- `runAt !== undefined`
- `cron === undefined`
- `now - nextRunAt > staleThresholdMs`

Those intents should be routed through `deferIntentAfterRecovery(...)` rather
than entering the normal fire queue.

### Suggested threshold model

V1 may expose a narrow schedule recovery threshold such as:

- `schedule.staleOneShotRecoveryThresholdMs`

If the team prefers to avoid a new public config field initially, the threshold
may ship as an implementation constant first.

Either way, the behavior should be:

- explicit
- documented
- testable
- visible through existing recovery events

### Operator posture

A deferred stale one-shot should remain inspectable and actionable.
The operator or host should be able to:

- reschedule it
- cancel it
- allow it to continue on a later pass

This keeps the kernel honest:

- the scheduler does not guess whether stale intent still matches user intent
- the control plane keeps the recovery decision legible

## Part 4: explicit gateway pause/resume for schedule execution

### Decision

Add an explicit gateway control-plane latch for schedule execution.

### Recommended shape

The gateway should expose method(s) equivalent to:

- `scheduler.pause`
- `scheduler.resume`
- optional `scheduler.status`

The daemon should hold the live pause state and pass a dynamic execution
predicate into scheduler wiring.

### Where the predicate must apply

The pause state should be checked in at least three places:

- before recovery catch-up execution
- before arming new schedule timers
- immediately before `fireIntent(...)` performs execution

This should be a real-time daemon control-plane latch rather than a static
re-read of `schedule.enabled`.

### Pause-state lifecycle

V1 should keep pause state daemon-local and non-persistent.

That means:

- `scheduler.pause` affects the live daemon process only
- daemon restart implicitly clears the pause and resumes normal execution
- durable disablement remains the job of configuration such as
  `schedule.enabled`

This keeps pause aligned with incident response posture rather than turning it
into a second durable configuration system that operators may forget to clear.

### Why this belongs in the gateway

The gateway already owns:

- the operator-facing control plane
- session supervision
- schedule-run execution wiring

Pause/resume is therefore an experience-ring and operations concern, not a
kernel-authority redesign.

## Explicit Non-Recommendation: no memory-only branch inside `runtime.schedule.*`

This RFC explicitly rejects a design where `ScheduleIntentCreateInput` grows an
`ephemeral` or `sessionOnly` mode that bypasses durable events.

That would weaken current repository invariants:

- `schedule_intent` events are the authoritative replay surface
- `listIntents(...)` is expected to reflect scheduler truth
- `getProjectionSnapshot()` is expected to be rebuildable from events
- `schedule_mutation` governance remains auditable as a real mutation

If Brewva later needs transient reminders that intentionally die with the
daemon, that should be proposed as a separate gateway/control-plane trigger
surface adjacent to heartbeat policy, not mixed into `runtime.schedule.*`.

## Validation Signals

This RFC should be considered successful only if the implementation produces
all of the following.

### Runtime and recovery correctness

- contract coverage showing that recurring cron intents persist jittered
  `nextRunAt` values through create, update, fire, and recovery
- recovery coverage proving that catch-up decisions use the same due-time model
  that execution uses
- no regression in replay rebuild when schedule projection artifacts are deleted

### Operational behavior

- test coverage showing reduced exact-boundary convergence for multiple intents
  sharing the same cron expression
- contract coverage for stale one-shot deferral
- gateway contract coverage for pause/resume behavior

### User-facing ergonomics

- tool contract coverage for the bounded `follow_up` timing selectors
- tool-path tests proving wrapper output compiles to canonical
  `schedule_intent` calls
- no regression in explicit `schedule_intent` behavior for advanced callers

## Promotion Criteria

This note is ready for promotion only when:

1. recurring jitter is implemented without creating replay/projection drift
2. stale one-shot recovery deferral is implemented and documented
3. the gateway exposes an explicit schedule pause surface
4. a user-facing follow-up wrapper exists above `schedule_intent`
5. stable docs describe the new scheduling posture without weakening the
   replay-first and effect-boundary contracts

## Source Anchors

- `packages/brewva-runtime/src/schedule/service.ts`
- `packages/brewva-runtime/src/contracts/schedule.ts`
- `packages/brewva-runtime/src/governance/tool-governance.ts`
- `packages/brewva-tools/src/schedule-intent.ts`
- `packages/brewva-gateway/src/daemon/schedule-runner.ts`
- `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
- `packages/brewva-gateway/src/daemon/heartbeat-policy.ts`
- `packages/brewva-gateway/src/session/schedule-trigger.ts`
- `docs/reference/runtime.md`
- `docs/reference/configuration.md`
- `docs/reference/events.md`
- `docs/reference/gateway-control-plane-protocol.md`
- `docs/architecture/cognitive-product-architecture.md`

## Residual Questions

- should recurring jitter remain an internal policy constant or eventually
  become explicit public schedule tuning
- should jitter policy parameters themselves ever be recorded per intent, or is
  persisting only the computed `nextRunAt` sufficient for the desired replay
  and migration semantics
- if Brewva later adds richer client aliases such as `/loop`, should they stay
  purely client-side or share a reusable front-end compiler layer
- should future transient control-plane reminders share machinery with
  heartbeat scheduling or remain a separate daemon lane
