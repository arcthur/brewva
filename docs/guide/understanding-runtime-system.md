# Understanding Runtime System

## Core Object

`RoasterRuntime` in `packages/roaster-runtime/src/runtime.ts` is the central system object.

It composes the following subsystems:

- `skills`
- `ledger`
- `verification`
- `parallel`
- `parallelResults`
- `events`
- `contextBudget`
- `contextInjection`
- `fileChanges`
- `costTracker`

Runtime state reconstruction is handled by tape replay (`checkpoint + delta`) via
`TurnReplayEngine`, not by persisted runtime session-state snapshot files.

## Shared Type Contract

All core contracts are defined in `packages/roaster-runtime/src/types.ts`, including:

- Skill contracts and selection types
- Ledger row and digest types
- Verification evidence and report types
- Event and replay types
- Task/truth/tape state and event payload types
- Patch set and rollback result types
- Parallel slot and worker result types
- Cost tracking types

## Configuration Contract

- Defaults: `packages/roaster-runtime/src/config/defaults.ts`
- Loader: `packages/roaster-runtime/src/config/loader.ts`
- Merge: `packages/roaster-runtime/src/config/merge.ts`
