# Understanding Runtime System

This guide explains the conceptual shape of the runtime surface. For the full
method-level contract and caller-specific ports, use:

- `docs/reference/runtime.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/artifacts-and-paths.md`

## Runtime Shape

`BrewvaRuntime` (`packages/brewva-runtime/src/runtime/runtime.ts`) is the stable runtime
instance contract.

Its public root shape is semantic, not implementation-organized:

- `runtime.authority`
- `runtime.inspect`

This is the default semantic runtime vocabulary that product surfaces read
against. Caller-specific ports narrow it by role: hosted sessions get
`authority + inspect + operator + extensions`, tools get
`authority + inspect + tool extensions`, and operator products get
`inspect + operator`.

The point is not to hide internal machinery. The point is to make the default
public surface line up with authority boundaries instead of exposing a wide bag
of mixed runtime mechanisms.

## Surface Semantics

The root surfaces and repo-owned operator port have different jobs:

- `authority` changes commitments, replay truth, admission state, verification
  sufficiency, or rollback identity
- `inspect` is read-only and exists for explanation, inspection, and operator
  products
- `operator` owns explicit rebuild, hydration, registration, credential binding
  resolution, hosted observations, and bounded recovery machinery

This is a semantic split, not a namespace taxonomy. A concern such as context
or scheduling may contribute methods to more than one surface.

## What Stays Internal

Some machinery is still real, but it is not the public runtime contract:

- raw event append outside typed descriptor validation
- raw turn-WAL mutation outside recovery scheduler ports
- service classes, stores, trackers, and replay engines

Repo-owned code may still use those mechanisms through dedicated runtime
subpaths such as `@brewva/brewva-runtime/recovery`,
`@brewva/brewva-runtime/event-log`, and controlled typed extension ports, but
they are not the default integration surface for products or external
consumers.

Those subpaths and extension ports are controlled, allowlisted TypeScript ports.
They do not preserve the removed `@brewva/brewva-runtime/internal` barrel, do
not expose runtime capability tokens, and do not expose arbitrary service
instance state.

Inside `packages/brewva-runtime`, implementation ownership follows
`domain/<name>/` slices. Domains own their `api.ts`, `types.ts`, registrar,
events, and direct runtime surface factories; cross-domain implementation
imports go through the API or type seam.

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
`packages/brewva-runtime/src/public/index.ts` and the domain-owned `types.ts`
modules under `packages/brewva-runtime/src/domain/`, including:

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
