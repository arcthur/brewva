# Research: Authority-Surface Narrowing And Runtime-Facade Compression

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-04-04`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- Brewva's public runtime contract is organized around semantic root surfaces:
  `authority`, `inspect`, and `maintain`
- the default coupling surface follows authority boundaries rather than
  implementation breadth
- `public width is not authority width` is the interpretation rule for runtime
  APIs and docs
- repo-owned implementation helpers stay under
  `@brewva/brewva-runtime/internal`, not the root public entrypoint
- future public APIs must explain which semantic surface they belong to before
  widening the root contract

## Stable References

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`

## Current Implementation Notes

- `docs/reference/runtime.md` defines the stable root shape and the
  `authority` / `inspect` / `maintain` split.
- `docs/architecture/system-architecture.md` treats hosted control-plane
  concerns, replay truth, and maintenance machinery as distinct layers rather
  than one flat runtime bag.
- The root package export policy in `AGENTS.md` and the current package layout
  keep service/store/tracker/engine classes under
  `@brewva/brewva-runtime/internal`.

## Remaining Backlog

- If Brewva ever needs a new root semantic surface or a materially different
  interpretation rule, start a new focused RFC instead of widening this
  promoted pointer back into a proposal.
- Do not reintroduce a wide `runtime.<domain>.*` contract as the default
  integration narrative.
