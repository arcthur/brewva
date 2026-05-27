# Understanding Runtime System

This guide explains the conceptual shape of the runtime surface. For the full
method-level contract and caller-specific ports, use:

- `docs/reference/runtime.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/artifacts-and-paths.md`

## Runtime Shape

`createBrewvaRuntime(...)` (`packages/brewva-runtime/src/runtime/runtime.ts`) is
the stable runtime construction boundary. It returns one frozen four-port
runtime with `identity`, `config`, `tape`, `kernel`, `model`, `start`, `turn`,
and `close`.

The public root shape is constitutional, not implementation-organized:

- `tape` owns truth
- `kernel` owns consequence
- `model` owns attention
- `turn` owns runtime physics

Gateway hosted code builds `HostedRuntimeAdapterPort` around the public
four-port runtime. That adapter is package-owned transport/control-plane
plumbing; it does not recover a private runtime controller, and it must not leak
back into `@brewva/brewva-runtime`.

## Surface Semantics

The four ports have different jobs:

- `tape` is the replayable source for committed facts and projections
- `kernel` is the only authorization and tool-transaction boundary
- `model` materializes attention from tape-derived state
- `turn` coordinates provider streaming, budget pressure, retry, interruption,
  and terminal commit frames

This split is an ownership boundary, not a namespace taxonomy. A concern such
as cost, recovery, or scheduling should be expressed as canonical tape events,
kernel decisions, model attention, or runtime physics instead of becoming a new
public root domain.

Product surfaces may still use a short loop:
`receive -> orient -> authorize -> act -> verify -> handoff`. That loop is a
projection over the four ports. Work Cards, attention options, SkillCards,
handoff anchors, and inspect renderers make evidence easier to use, but they do
not add root ports or authority domains.

## What Stays Internal

Some machinery is still real, but it is not the public runtime contract:

- raw canonical tape commit outside runtime/kernel/model internals
- raw turn-WAL mutation outside recovery scheduler ports
- service classes, stores, trackers, and replay engines

Repo-owned code may still use product vocabulary in explicit
`@brewva/brewva-vocabulary/*` subpaths, policy helpers in
`@brewva/brewva-runtime/security`, and package-owned infrastructure ports such
as `@brewva/brewva-gateway/recovery`.
These subpaths are not alternate runtime roots.

Those subpaths and extension ports are controlled, allowlisted TypeScript ports.
They do not preserve the removed `@brewva/brewva-runtime/internal` barrel, do
not expose runtime capability tokens, and do not expose arbitrary service
instance state.

Inside `packages/brewva-runtime`, new implementation ownership follows the
four-port folders under `runtime/tape`, `runtime/kernel`, `runtime/model`, and
`runtime/turn`. Existing `domain/<name>/` slices were deleted and must not be
used as a pattern to extend.

## Replay And Durability

Replay remains tape-first.

- tape and receipts are durable source of truth
- Recovery WAL and rollback material are durable transient state
- projections and other read models are rebuildable state
- host/UI caches are not replay authority

`TurnReplayEngine` and session hydration rebuild runtime state from persisted
events. That replay model is what allows operator inspection and exact resume
to stay deterministic.

## Governance Core

Runtime behavior is still organized around hard boundaries:

- effect authorization and exact resume
- replay truth for task, truth, and schedule commitments
- verification sufficiency
- rollback identity
- bounded maintenance and recovery

The runtime does not try to become an adaptive planning loop in disguise. Its
job is to keep execution explainable, replayable, and durable where it matters.

## Scheduling Boundary

Scheduling is split on purpose:

- create, update, and cancel intent are authority operations
- list and projection snapshot are inspection operations
- raw WAL ingress for scheduler recovery stays internal

That split keeps scheduler internals from becoming the default product-facing
runtime contract.

## Shared Contract Surface

Shared contracts are defined explicitly in
`packages/brewva-runtime/src/public/index.ts` and the owner-scoped `types.ts`
modules under `packages/brewva-runtime/src/runtime/` and
`packages/brewva-runtime/src/runtime/tape/`, including:

- task, truth, schedule, and evidence contracts
- event, replay, receipt, and WAL contracts
- context, verification, and cost contracts
- governance and tool-boundary contracts

## Configuration Boundary

Config contract entry points:

- defaults: `packages/brewva-runtime/src/config/defaults.ts`
- loader: `packages/brewva-runtime/src/config/loader.ts`
- normalize: `packages/brewva-runtime/src/config/normalize.ts`

`BrewvaConfig` remains runtime-owned configuration state. Products consume the
normalized readonly snapshot exposed on the runtime root and caller-specific
ports.

## Related Docs

- `docs/guide/orchestration.md`
- `docs/journeys/operator/interactive-session.md`
- `docs/reference/runtime.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/configuration.md`
