# Reference: Memory Curator

Implementation entrypoint:

- `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`

Supporting helpers:

- `packages/brewva-deliberation/src/cognition.ts`
- `packages/brewva-deliberation/src/proposals.ts`

## Role

`MemoryCurator` is the single control-plane entry point for cognition
rehydration.

It does not create kernel memory. It selects non-authoritative cognition
artifacts and re-enters them through the proposal boundary as `context_packet`
proposals.

## Current Scope

Current built-in rehydration paths are intentionally narrow:

- `reference`
  - scan `.brewva/cognition/reference/`
  - select prompt-relevant artifacts by local ranking and recency
  - submit evidence-backed `context_packet` proposals with stable packet keys
- `latest summary`
  - scan `.brewva/cognition/summaries/`
  - select the latest `status_summary` for the same `session_scope`
  - re-enter it through the same proposal and receipt path

There are no default `procedure`, `episode`, `open_loop`, or adaptation
rehydration paths anymore.

## Scope Model

- workspace-scoped cognition knowledge
  - `reference`
- session-scoped resumability
  - latest `status_summary`
  - rehydration requires a matching `session_scope`

Foreign session state is ignored even when lexical ranking matches.

## Telemetry

- `memory_reference_rehydrated`
- `memory_reference_rehydration_failed`
- `memory_summary_rehydrated`
- `memory_summary_rehydration_failed`

## Boundary Rules

`MemoryCurator` may:

- read cognition artifacts
- rank or select artifacts outside the kernel
- submit `context_packet` proposals

`MemoryCurator` may not:

- mutate truth, task, ledger, or tape state directly
- bypass proposal receipts
- inject cognition artifacts implicitly

## Design Rule

All default rehydration converges through this one curator entry point. The
goal is to keep the default memory path small and inspectable instead of
reintroducing multiple competing memory hooks.
