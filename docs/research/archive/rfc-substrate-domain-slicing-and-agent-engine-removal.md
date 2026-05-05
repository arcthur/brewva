# Archived RFC: Substrate Domain Slicing And Agent-Engine Removal

## Document Metadata

- Status: `archived`
- Owner: substrate, gateway, provider-core, and runtime maintainers
- Last reviewed: `2026-05-06`
- Promotion target:
  - `docs/research/decisions/substrate-turn-loop-internalization.md`
  - `docs/research/decisions/substrate-domain-slicing-and-root-surface-compression.md`

## Archive Summary

This RFC proposed deleting `@brewva/brewva-agent-engine`, moving the low-level
model/tool loop into `@brewva/brewva-substrate/turn`, slicing substrate into
explicit domain subpaths, and compressing the substrate root to cross-domain
contract vocabulary.

The accepted contracts now live in:

- `docs/research/decisions/substrate-turn-loop-internalization.md`
- `docs/research/decisions/substrate-domain-slicing-and-root-surface-compression.md`

Current code and stable docs are authoritative. This archived note only keeps
the historical breadcrumb for why the package deletion and substrate domain
split happened.
