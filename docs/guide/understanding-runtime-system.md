# Understanding Runtime System

## Runtime Shape

`BrewvaRuntime` (`packages/brewva-runtime/src/runtime.ts`) is the governance facade.
It exposes domain APIs instead of a flat method bag:

- `runtime.skills`
- `runtime.context`
- `runtime.tools`
- `runtime.task`
- `runtime.truth`
- `runtime.memory`
- `runtime.schedule`
- `runtime.turnWal`
- `runtime.events`
- `runtime.verification`
- `runtime.cost`
- `runtime.session`

The facade should stay thin: constructor wiring + delegation into services.

## Governance Core

Runtime behavior is organized around governance boundaries:

- trust boundary: evidence ledger + verification + truth facts
- execution boundary: tool gate + security policy + context compaction gate
- economic boundary: cost tracking + budget actions
- durability boundary: event tape + checkpoint replay + turn WAL

The runtime does not attempt to make the model "smarter" through adaptive routing loops.
Its role is to keep behavior explainable, bounded, and replayable.

## Replay And Session State

Session runtime maps are managed by
`packages/brewva-runtime/src/services/session-state.ts` (`RuntimeSessionStateStore`).

Cross-process reconstruction is tape-first:

- `TurnReplayEngine` rebuilds state via checkpoint + delta
- folded slices include task/truth/cost/evidence/memory projection state
- runtime bootstrap hydration restores control-plane state from persisted events

## Scheduling Boundary

`ScheduleIntentService` lazily initializes scheduler internals and keeps
scheduler orchestration behind a narrow runtime port boundary.
This avoids hidden coupling from scheduling internals back into facade methods.

## Shared Contract Surface

Core contracts are defined in `packages/brewva-runtime/src/types.ts`, including:

- skill contracts and dispatch/cascade types
- ledger and truth/task payload contracts
- event/replay/wal contracts
- verification and cost summary contracts
- memory projection contracts

## Configuration Boundary

Config contract entry points:

- defaults: `packages/brewva-runtime/src/config/defaults.ts`
- loader: `packages/brewva-runtime/src/config/loader.ts`
- merge/normalize: `packages/brewva-runtime/src/config/merge.ts`, `packages/brewva-runtime/src/config/normalize.ts`

`BrewvaConfig.ui.quietStartup` remains runtime-owned and is read by CLI session bootstrap.
