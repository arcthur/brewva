# Decision: Canonical Hosted Turn Envelope

## Metadata

- Decision: the hosted turn envelope delegates model/tool turn ownership to `runtime.turn(...)`.
- Date: `2026-04-21`
- Status: accepted
- Stable docs:
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-adapter.ts`
  - `packages/brewva-gateway/src/delegation/entry.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/engine/sessions/wire.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/engine/sessions/session-wire.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/worker/main.ts`

## Decision Summary

- `runtime.turn(...)` is the model/tool turn owner; the hosted envelope is a transport/session adapter.
- production hosted prompt entrypoints enter through `packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.ts`.
- the envelope owns profile resolution, runtime-turn binding, schedule-trigger prelude, WAL recovery entry mapping, and suspended-vs-terminal status mapping.
- turn truth is canonical tape owned by Runtime; gateway does not write `turn.input.recorded` or `turn.render.committed`.
- Envelope diagnostics stay process-local; No durable envelope-diagnostics event should be added.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
