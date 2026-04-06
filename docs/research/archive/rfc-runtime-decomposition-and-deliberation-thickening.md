# Research: Runtime Decomposition and Deliberation Thickening

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/configuration.md`

## Archive Summary

This note is archived as a large migration-era decomposition record.

It mixed three roles that no longer belong in one file:

- target architecture proposal
- implementation progress log
- regression checklist for runtime hardening

The stable architecture and reference docs now carry the real contract.

## What This RFC Contributed

The lasting ideas that survived were:

- the public runtime surface should stay disciplined rather than regrowing a
  broad mechanism-first facade
- replay, config sealing, hydration, and governance should stay explicit and
  exact
- deliberation behavior should not silently widen kernel authority
- runtime and hosted layers need strong anti-drift pressure after migrations

## What Changed Afterward

Important parts of this draft were later narrowed or replaced:

- the later boundary-first subtraction direction superseded this file's
  standalone deliberation-package trajectory
- current package ownership should be read from stable docs and current code,
  not from this archive note
- several sections in the original draft became implementation-log detail
  rather than lasting architectural guidance

## Read These Instead

- `docs/architecture/system-architecture.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/configuration.md`
- `docs/research/promoted/rfc-boundary-first-subtraction-and-model-native-recovery.md`
- `docs/research/promoted/rfc-authority-surface-narrowing-and-runtime-facade-compression.md`

## Why Keep This File

Keep this archive summary only for migration archaeology:

- tracing why earlier runtime hardening work existed
- understanding the anti-drift intent behind later architecture cleanup
- locating the historical bridge between pre-subtraction and post-subtraction
  runtime narratives

For detailed rollout history, use git history rather than restoring the former
1000-line migration log.
