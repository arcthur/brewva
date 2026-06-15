# Decision: Substrate SDK, Diagnostics, And Compaction Mechanism Ports

## Metadata

- Decision: Substrate exposes a thin SDK composition path plus mechanism-only diagnostics, provenance, event, tool-wrapper, and compaction ports.
- Date: `2026-05-06`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
- Code anchors:
  - `packages/brewva-substrate/src/provenance/index.ts`
  - `packages/brewva-substrate/src/execution/index.ts`
  - `packages/brewva-substrate/src/compaction/index.ts`
  - `packages/brewva-substrate/src/tools/wrap.ts`
  - `test/unit/substrate/{provenance,event-bus,compaction,tool-wrapper}.unit.test.ts`
  - `test/contract/substrate/substrate-entrypoint.contract.test.ts`

## Decision Summary

- `@brewva/brewva-substrate/sdk` was removed by the four-port runtime promotion; direct hosts construct `BrewvaRuntime` rather than creating a second turn owner.
- SDK services return `BrewvaSubstrateDiagnostic` values for recoverable startup or composition issues; invariant failures still throw.
- SDK host-api wiring covers turn-loop-aligned events and provider/context/tool hooks without synthesizing gateway hosted prompt input policy.
- substrate's `provenance/` owns reusable source-info vocabulary for prompt, tool, SDK, resource, and future extension-discovered artifacts. (As of WS5 in `rfc-hosted-implementation-subtraction-and-ops-facade-collapse.md`, this is substrate-internal — the `./provenance` public subpath was removed for having zero external consumers; it is consumed via relative paths such as `prompt/templates.ts`.)
- substrate's `execution/` owns a sequential event-bus primitive that separates subscriber bus access from controller emit authority; listener settlement remains part of caller settlement. (As of WS5, `./execution` is no longer a public subpath; the tool-phase primitives it defines stay reachable through `./tools`, and the event-bus is substrate-internal.)
- `@brewva/brewva-substrate/tools` owns `wrapBrewvaTool(...)` for metadata-preserving cross-cutting tool decoration.
- `@brewva/brewva-substrate/compaction` owns pure summary, token-estimation, threshold, cut-point, and message-projection helpers only.
- Gateway still owns hosted envelopes, profile selection, compaction trigger/recovery policy, and terminal render authority.
- Runtime still owns replay, WAL, governance gates, context pressure authority, and durable `session_compact` receipts.
- The substrate root remains contract-only; none of these mechanism ports are exported from `@brewva/brewva-substrate`.

## Amendment — WS5 single-consumer seam recovery (`2026-06-15`)

- The `provenance/` and `execution/` summary bullets above are no longer backed by
  public package subpaths. WS5 removed the `./provenance` and `./execution`
  exports from `packages/brewva-substrate/package.json` (alongside
  `./persistence`) for having zero external production consumers; the inline
  qualifications already appended to those two bullets record the same change.
- The implementations stay substrate-internal and are reached via relative
  paths: `prompt/templates.ts` imports `../provenance/source-info.js`, and the
  execution tool-phase primitives are re-exposed through the `./tools` subpath via
  `tools/api.ts`. The event-bus (`createBrewvaEventBus`) and the persistence
  session-bundle helpers are now consumed only by unit tests.
- This mirrors the WS5 amendment in
  `docs/research/decisions/substrate-domain-slicing-and-root-surface-compression.md`
  ("Amendment — WS5 single-consumer seam recovery"), which records the same
  subpath removals from the substrate domain-slicing decision and the seam
  principle behind them (a public API with no second consumer is a hypothetical
  seam, not architecture).
- The code anchors above (`src/provenance/index.ts`, `src/execution/index.ts`)
  remain accurate: the internal source files still exist; only their public
  subpath exports were withdrawn.

## Builds On

- `docs/research/decisions/substrate-domain-slicing-and-root-surface-compression.md`
- `docs/research/decisions/substrate-turn-loop-internalization.md`
- `docs/research/decisions/brewva-c2-full-internalization-and-kernel-substrate-boundaries.md`
- `docs/research/decisions/provider-core-domain-slicing-and-driver-port-boundaries.md`

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
