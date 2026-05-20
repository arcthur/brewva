# Decision: Runtime Domain Slicing And Controlled Extension Ports

## Metadata

- Decision: Runtime implementation ownership is sliced by domain and repo-owned escape hatches are explicit controlled extension ports
- Date: `2026-05-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/events/README.md`
  - `docs/guide/understanding-runtime-system.md`
- Code anchors:
  - Removed by the four-port runtime cutover.

## Supersession Note

This decision is historical. The four-port runtime cutover removed the public
`authority` / `inspect` root and deleted the runtime `domain/<name>/` lattice.
Do not use this document as implementation guidance.

## Decision Summary

- Runtime package implementation ownership previously followed domain slices under
  `domain/<name>/`, with explicit `api.ts`, `types.ts`, `registrar.ts`, and
  `runtime-surface.ts` seams.
- The former semantic public root exposed authority and inspection surfaces.
  The four-port runtime cutover supersedes that shape with
  `identity/config/tape/kernel/model/start/turn/close`.
- The former descriptor registry and domain surface assembly are no longer
  implementation guidance. Current implementation guidance is the four-port
  runtime RFC and the promoted architecture fitness tests.

## Superseded by

- `docs/research/decisions/runtime-public-root-compression.md`
- `docs/research/decisions/runtime-domain-admission-and-deletion.md`
- `docs/research/decisions/runtime-factory-ports.md`
- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
