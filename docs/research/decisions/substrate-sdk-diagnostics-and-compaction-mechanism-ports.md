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
  - `packages/brewva-substrate/src/sdk/index.ts`
  - `packages/brewva-substrate/src/provenance/index.ts`
  - `packages/brewva-substrate/src/execution/index.ts`
  - `packages/brewva-substrate/src/compaction/index.ts`
  - `packages/brewva-substrate/src/tools/wrap.ts`
  - `test/unit/substrate/{sdk,provenance,event-bus,compaction,tool-wrapper}.unit.test.ts`
  - `test/contract/substrate/substrate-entrypoint.contract.test.ts`

## Decision Summary

- `@brewva/brewva-substrate/sdk` is the one-call and two-stage in-memory composition surface for direct substrate hosts.
- SDK services return `BrewvaSubstrateDiagnostic` values for recoverable startup or composition issues; invariant failures still throw.
- SDK host-api wiring covers turn-loop-aligned events and provider/context/tool hooks without synthesizing gateway hosted prompt input policy.
- `@brewva/brewva-substrate/provenance` owns reusable source-info vocabulary for prompt, tool, SDK, resource, and future extension-discovered artifacts.
- `@brewva/brewva-substrate/execution` owns a sequential event-bus primitive that separates subscriber bus access from controller emit authority; listener settlement remains part of caller settlement.
- `@brewva/brewva-substrate/tools` owns `wrapBrewvaTool(...)` for metadata-preserving cross-cutting tool decoration.
- `@brewva/brewva-substrate/compaction` owns pure summary, token-estimation, threshold, cut-point, and message-projection helpers only.
- Gateway still owns hosted envelopes, profile selection, compaction trigger/recovery policy, and terminal render authority.
- Runtime still owns replay, WAL, governance gates, context pressure authority, and durable `session_compact` receipts.
- The substrate root remains contract-only; none of these mechanism ports are exported from `@brewva/brewva-substrate`.

## Builds On

- `docs/research/decisions/substrate-domain-slicing-and-root-surface-compression.md`
- `docs/research/decisions/substrate-turn-loop-internalization.md`
- `docs/research/decisions/brewva-c2-full-internalization-and-kernel-substrate-boundaries.md`
- `docs/research/decisions/provider-core-domain-slicing-and-driver-port-boundaries.md`

## Superseded by

- None.
