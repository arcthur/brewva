# Research: Valibot Streaming Parse And TypeBox Boundary

## Document Metadata

- Status: `archived`
- Owner: provider-core maintainers
- Last reviewed: `2026-05-03`
- Promotion target:
  - `docs/reference/provider-streaming.md`
  - `docs/research/decisions/typebox-derived-provider-streaming-parse-boundary.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/anti-patterns.md`
- Accepted decision:
  - `docs/research/decisions/typebox-derived-provider-streaming-parse-boundary.md`

## Archive Summary

This RFC started from a Valibot-based proposal to close the schema-free gap
between `partial-json` recovery and terminal AJV validation for streamed
tool-call arguments.

Implementation review rejected the dual-schema Valibot boundary in favor of a
TypeBox-derived streaming projection. Provider-core now derives an internal
partial TypeBox schema from `context.tools`, emits an optional advisory
`parseStatus` on tool-call events, and keeps terminal AJV validation as the
authoritative gate.

Read the accepted decision and stable provider streaming reference for the
current contract. This archived note exists only to preserve the migration
rationale and original alternative.
