# Understanding Runtime System

This guide explains the conceptual shape of the runtime surface. For the full
method-level contract and caller-specific ports, use:

- `docs/reference/runtime.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/artifacts-and-paths.md`

## Runtime Shape

`BrewvaRuntime` (`packages/brewva-runtime/src/runtime.ts`) is the stable runtime
instance contract.

Its public root shape is semantic, not implementation-organized:

- `runtime.authority`
- `runtime.inspect`
- `runtime.maintain`

This is the default semantic runtime vocabulary that product surfaces read
against. Caller-specific ports still narrow it by role: hosted sessions get all
three roots, tools get `authority + inspect`, and operator products get
`inspect + limited maintain`.

The point is not to hide internal machinery. The point is to make the default
public surface line up with authority boundaries instead of exposing a wide bag
of mixed runtime mechanisms.

## Surface Semantics

The three root surfaces have different jobs:

- `authority` changes commitments, replay truth, admission state, verification
  sufficiency, or rollback identity
- `inspect` is read-only and exists for explanation, inspection, and operator
  products
- `maintain` owns explicit rebuild, hydration, registration, and bounded
  recovery machinery

This is a semantic split, not a namespace taxonomy. A concern such as context
or scheduling may contribute methods to more than one surface.

## What Stays Internal

Some machinery is still real, but it is not the public runtime contract:

- raw event append
- raw turn-WAL mutation
- service classes, stores, trackers, and replay engines

Repo-owned code may still use those capabilities through
`@brewva/brewva-runtime/internal`, but they are not the default integration
surface for products or external consumers.

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

Core contracts are defined in `packages/brewva-runtime/src/contracts/index.ts`,
including:

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
normalized readonly snapshot exposed on the runtime instance.

## Related Docs

- `docs/guide/orchestration.md`
- `docs/journeys/operator/interactive-session.md`
- `docs/reference/runtime.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/configuration.md`
