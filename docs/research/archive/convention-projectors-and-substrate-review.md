# Archived Research: Convention Projectors And Substrate Review

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-06-01`
- Promotion target:
  - `docs/reference/events/README.md`
  - `docs/research/decisions/convention-lifecycle-governance.md`

## Archive Summary

This note is archived because the automatic convention projector work did not
land with the convention lifecycle foundation. Stable event docs now describe
`convention_health_degraded` and `convention_conflict_detected` as reserved
projector outputs with no active automation guarantee.

Future work should start from a smaller active note for a concrete producer,
such as a health projector or predicate-backed conflict detector. The substrate
shadow-replay reviewer should remain separate unless selection-plane replay has
fresh implementation evidence.
