# Decision: TypeBox-Derived Provider Streaming Parse Boundary

## Metadata

- Decision: provider streaming parse is an advisory TypeBox-derived projection
- Date: `2026-05-03`
- Status: accepted
- Stable docs:
  - `docs/reference/provider-streaming.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/anti-patterns.md`
- Code anchors:
  - `packages/brewva-provider-core/src/parse/json-parse.ts`
  - `packages/brewva-provider-core/src/parse/typebox-partialize.ts`
  - `packages/brewva-provider-core/src/parse/types.ts`
  - `packages/brewva-provider-core/src/stream/tool-call-folder.ts`
  - `packages/brewva-provider-core/src/stream/run-provider-stream.ts`
  - `packages/brewva-provider-core/src/contracts/index.ts`

## Decision Summary

- TypeBox remains the sole canonical tool-argument schema source.
- Provider streaming derives an internal partial TypeBox projection from `context.tools`.
- `partial-json` remains responsible for structural recovery of incomplete JSON strings.
- Streaming parse emits optional advisory `parseStatus` on tool-call events; it does not replace `ToolCall.arguments` or terminal AJV validation.
- `likely_invalid` is conservative: incomplete JSON prefixes, missing required fields, and values terminal AJV would coerce must not produce false invalid signals.
- TypeBox-Value projection helpers remain internal to provider-core and are not exported from the root public API.

## Non-Goals

- No Valibot dependency or second authored schema language for tool arguments.
- No promotion of streaming parse results to authoritative validation.
- No public root API for `partialize`, registry construction, or TypeBox-Value-specific helpers.

## Validation Evidence

- `bun test test/unit/provider-core --timeout 600000`
- `bun run check`
- Representative nested edit-schema parse benchmark: `34.46µs` per parse over 50,000 iterations.

## Superseded by

- None.
